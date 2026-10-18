import type { PoolClient } from "pg";
import { pool } from "./database.js";
import {
  classifySocialContent,
  commentToMessageGate,
  decideSocialRoute,
  normalizeSocialEvent,
  type SocialCapabilitySnapshot,
  type SocialCategory,
  type SocialClassification,
  type TenantSocialRule,
} from "./social-channel-core.js";
import { loadActiveSocialRules } from "./social-moderation.js";
import { emitSocialModerationNotification } from "./social-notifications.js";

type Queryable = Pick<PoolClient, "query">;
const classifierVersion = "social-rules-v1";
const policyVersion = "social-routing-v1";

type StoredSocialResult = {
  social_event_id: string;
  duplicate: boolean;
  classification: SocialClassification;
  route: ReturnType<typeof decideSocialRoute>;
  comment_to_message: ReturnType<typeof commentToMessageGate>;
  notification_error?: boolean;
};

function disabledCapabilities(now = new Date()): SocialCapabilitySnapshot {
  return {
    dm_receive: false,
    dm_send: false,
    comment_list: false,
    comment_reply: false,
    comment_hide: false,
    comment_to_message: false,
    webhook: false,
    reply_window: false,
    checked_at: now.toISOString(),
    source: "cached_provider",
  };
}

function storedCapabilities(value: unknown): SocialCapabilitySnapshot {
  const disabled = disabledCapabilities();
  if (!value || typeof value !== "object" || Array.isArray(value)) return disabled;
  const source = value as Record<string, unknown>;
  return {
    dm_receive: source.dm_receive === true,
    dm_send: source.dm_send === true,
    comment_list: source.comment_list === true,
    comment_reply: source.comment_reply === true,
    comment_hide: source.comment_hide === true,
    comment_to_message: source.comment_to_message === true,
    webhook: source.webhook === true,
    reply_window: source.reply_window === true,
    checked_at: typeof source.checked_at === "string" ? source.checked_at : disabled.checked_at,
    source: source.source === "mock" || source.source === "provider" ? source.source : "cached_provider",
  };
}

async function existingResult(db: Queryable, tenantId: string, connectionId: string, externalEventId: string, contentHash: string): Promise<StoredSocialResult | null> {
  const result = await db.query(
    `SELECT e.social_event_id,e.content_hash,c.category,c.confidence,c.source,c.reason_codes,c.matched_rule_id,
            r.route,r.priority,r.requires_human,r.action_gate
       FROM social_events e
       LEFT JOIN social_classifications c ON c.social_event_id=e.social_event_id
       LEFT JOIN social_routing_decisions r ON r.social_event_id=e.social_event_id
      WHERE e.tenant_id=$1 AND e.channel_connection_id=$2 AND e.external_event_id=$3`,
    [tenantId, connectionId, externalEventId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.content_hash !== contentHash) throw new Error("social_event_idempotency_conflict");
  if (!row.category || !row.route) throw new Error("social_event_incomplete");
  return {
    social_event_id: row.social_event_id,
    duplicate: true,
    classification: {
      category: row.category,
      confidence: Number(row.confidence),
      source: row.source,
      reason_codes: row.reason_codes,
      matched_rule_id: row.matched_rule_id,
    },
    route: { route: row.route, priority: row.priority, requires_human: row.requires_human },
    comment_to_message: row.action_gate,
  } as StoredSocialResult;
}

export async function ingestSocialEvent(input: {
  tenant_id: string;
  event: Record<string, unknown>;
  tenant_rules?: TenantSocialRule[];
  ai_suggestion?: { category: SocialCategory; confidence: number } | null;
  entitlements?: Iterable<string>;
  user_authorized?: boolean;
  reply_window_open?: boolean;
  notification_delivery_mode?: "configured" | "in_app_only";
}, db = pool): Promise<StoredSocialResult> {
  const event = normalizeSocialEvent(input.event);
  const client = "connect" in db ? await db.connect() : null;
  const queryable = (client ?? db) as Queryable;
  try {
    if (client) await client.query("BEGIN");
    const connection = await queryable.query(
      `SELECT channel_type,status,external_account_id,capability_snapshot
         FROM channel_connections
        WHERE tenant_id=$1 AND connection_id=$2
        FOR UPDATE`,
      [input.tenant_id, event.channel_connection_id],
    );
    const row = connection.rows[0];
    if (!row || row.status !== "ready" || row.channel_type !== event.provider || row.external_account_id !== event.external_account_id) {
      throw new Error("social_connection_not_ready");
    }
    const duplicate = await existingResult(queryable, input.tenant_id, event.channel_connection_id, event.external_event_id, event.content_hash);
    if (duplicate) {
      if (client) await client.query("COMMIT");
      return duplicate;
    }
    const inserted = await queryable.query<{ social_event_id: string }>(
      `INSERT INTO social_events
        (tenant_id,channel_connection_id,provider,event_type,external_account_id,external_event_id,external_user_id,
         content,content_hash,video_id,comment_id,parent_comment_id,metadata,occurred_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING social_event_id`,
      [input.tenant_id, event.channel_connection_id, event.provider, event.event_type, event.external_account_id,
       event.external_event_id, event.external_user_id, event.content, event.content_hash, event.video_id, event.comment_id,
       event.parent_comment_id, event.metadata, event.occurred_at],
    );
    const tenantRules = input.tenant_rules ?? await loadActiveSocialRules(input.tenant_id, queryable);
    const classification = event.event_type === "auth.revoked"
      ? { category: "unknown", confidence: 1, source: "deterministic", reason_codes: ["authorization_revoked"], matched_rule_id: null } as SocialClassification
      : classifySocialContent({ content: event.content, tenant_rules: tenantRules, ai_suggestion: input.ai_suggestion });
    const route = decideSocialRoute(event.event_type, classification);
    const capabilities = storedCapabilities(row.capability_snapshot);
    const commentToMessage = commentToMessageGate({
      event_type: event.event_type,
      classification,
      entitlements: input.entitlements ?? [],
      capabilities,
      user_authorized: input.user_authorized === true,
      reply_window_open: input.reply_window_open === true && capabilities.reply_window,
    });
    const socialEventId = inserted.rows[0].social_event_id;
    await queryable.query(
      `INSERT INTO social_classifications
        (social_event_id,tenant_id,category,confidence,source,reason_codes,matched_rule_id,classifier_version)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [socialEventId, input.tenant_id, classification.category, classification.confidence, classification.source,
       JSON.stringify(classification.reason_codes), classification.matched_rule_id, classifierVersion],
    );
    await queryable.query(
      `INSERT INTO social_routing_decisions
        (social_event_id,tenant_id,route,priority,requires_human,action_gate,policy_version)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [socialEventId, input.tenant_id, route.route, route.priority, route.requires_human, commentToMessage, policyVersion],
    );
    await queryable.query(`UPDATE social_events SET status='routed',updated_at=NOW() WHERE social_event_id=$1`, [socialEventId]);
    if (client) await client.query("COMMIT");
    let notificationError = false;
    try {
      await emitSocialModerationNotification({
        tenant_id: input.tenant_id,
        social_event_id: socialEventId,
        event_type: event.event_type,
        category: classification.category,
        delivery_mode: input.notification_delivery_mode,
      });
    } catch {
      notificationError = true;
    }
    return { social_event_id: socialEventId, duplicate: false, classification, route, comment_to_message: commentToMessage, notification_error: notificationError };
  } catch (error) {
    if (client) await client.query("ROLLBACK");
    throw error;
  } finally {
    client?.release();
  }
}
