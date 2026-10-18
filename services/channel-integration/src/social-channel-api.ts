import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "./database.js";
import { readBody, sendJson } from "./shared.js";
import { effectiveEntitlement } from "./subscriptions.js";
import {
  confirmSocialClassification,
  correctSocialClassification,
  createSocialRule,
  listSocialRules,
  recordSocialCaseAction,
  updateSocialRule,
} from "./social-moderation.js";
import { socialObservedRate, validateSocialQualityWindow, type SocialCaseAction } from "./social-moderation-core.js";
import { ingestSocialEvent } from "./social-channel.js";
import {
  createTikTokReviewMockEvent,
  tiktokReviewPrototypeDisclosure,
  tiktokReviewSamples,
  validateTikTokReviewEvent,
} from "./tiktok-review-demo.js";

type Auth = {
  tenant_id: string;
  role: "tenant_admin" | "supervisor" | "agent";
  actor_id: string;
  auth_kind: "api_key" | "console_session";
  platform_user_id: string | null;
};

async function jsonInput(request: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse((await readBody(request)).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("invalid_json");
  }
}

function actor(auth: Auth) {
  return { actor_type: auth.auth_kind, actor_id: auth.actor_id, platform_user_id: auth.platform_user_id };
}

function apiError(response: ServerResponse, requestId: string, error: unknown) {
  const raw = error instanceof Error ? error.message : "social_operation_failed";
  const pgCode = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const constraint = typeof error === "object" && error !== null && "constraint" in error ? String((error as { constraint?: unknown }).constraint ?? "") : "";
  const code = pgCode === "23505" ? constraint === "social_tenant_rules_active_priority_unique_idx" ? "social_rule_priority_conflict" : "social_rule_name_conflict" : raw;
  const status = code === "social_review_demo_disabled" || code === "admin_required" ? 403 : code.endsWith("_not_found") ? 404 : code.includes("conflict") || code === "social_category_unchanged" || code === "invalid_social_case_transition" || code === "social_case_resolved" ? 409 : 400;
  sendJson(response, status, { request_id: requestId, error: { code } });
}

function reviewDemoEnabled() {
  return process.env.SOCIAL_REVIEW_DEMO_ENABLED === "true";
}

async function ensureTikTokReviewConnection(auth: Auth, requestId: string) {
  const externalAccountId = `review-demo:${auth.tenant_id}`;
  const fixture = createTikTokReviewMockEvent({
    channel_connection_id: "123e4567-e89b-42d3-a456-426614174000",
    external_account_id: externalAccountId,
    event_type: "dm.message",
    content: tiktokReviewSamples["dm.message"][0],
  });
  const configuration = {
    mode: "synthetic",
    review_demo: true,
    authorization: "simulated_oauth",
    webhook: "simulated_subscription",
    no_provider_credentials: true,
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ connection_id: string }>(
      `SELECT connection_id FROM channel_connections
        WHERE tenant_id=$1 AND channel_type='tiktok' AND configuration->>'review_demo'='true'
        ORDER BY created_at LIMIT 1 FOR UPDATE`,
      [auth.tenant_id],
    );
    const connectionId = existing.rows[0]?.connection_id;
    const saved = connectionId
      ? await client.query(
          `UPDATE channel_connections
              SET display_name='TikTok Review Prototype',status='ready',external_account_id=$3,
                  capability_snapshot=$4,capability_checked_at=NOW(),configuration=$5,last_error_code=NULL,updated_at=NOW()
            WHERE tenant_id=$1 AND connection_id=$2
          RETURNING connection_id,display_name,status,external_account_id,capability_snapshot,capability_checked_at,configuration`,
          [auth.tenant_id, connectionId, externalAccountId, JSON.stringify(fixture.capabilities), JSON.stringify(configuration)],
        )
      : await client.query(
          `INSERT INTO channel_connections
            (tenant_id,channel_type,display_name,status,external_account_id,capability_snapshot,capability_checked_at,configuration)
           VALUES($1,'tiktok','TikTok Review Prototype','ready',$2,$3,NOW(),$4)
           RETURNING connection_id,display_name,status,external_account_id,capability_snapshot,capability_checked_at,configuration`,
          [auth.tenant_id, externalAccountId, JSON.stringify(fixture.capabilities), JSON.stringify(configuration)],
        );
    const row = saved.rows[0];
    await client.query(
      `INSERT INTO channel_connection_events(tenant_id,connection_id,event_type,result,detail)
       VALUES($1,$2,'tiktok_review_prototype_initialized','succeeded',$3)`,
      [auth.tenant_id, row.connection_id, JSON.stringify(tiktokReviewPrototypeDisclosure())],
    );
    await client.query(
      `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
       VALUES($1,$2,$3,'social.tiktok_review_prototype_initialized','channel_connection',$4,$5,$6)`,
      [auth.tenant_id, auth.auth_kind, auth.actor_id, row.connection_id, JSON.stringify({ ...configuration, network_calls: 0, provider_writes: 0 }), requestId],
    );
    await client.query("COMMIT");
    return row;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function tiktokReviewDemo(tenantId: string) {
  const [connection, events] = await Promise.all([
    pool.query(
      `SELECT connection_id,display_name,status,external_account_id,capability_snapshot,capability_checked_at,configuration
         FROM channel_connections
        WHERE tenant_id=$1 AND channel_type='tiktok' AND configuration->>'review_demo'='true'
        ORDER BY created_at LIMIT 1`,
      [tenantId],
    ),
    pool.query(
      `SELECT e.social_event_id,e.event_type,e.content,e.occurred_at,c.category,c.confidence,c.source,c.reason_codes,
              r.route,r.priority,r.requires_human,r.action_gate
         FROM social_events e
         JOIN channel_connections connection ON connection.connection_id=e.channel_connection_id
         JOIN social_classifications c ON c.social_event_id=e.social_event_id
         JOIN social_routing_decisions r ON r.social_event_id=e.social_event_id
        WHERE e.tenant_id=$1 AND e.provider='tiktok' AND connection.configuration->>'review_demo'='true'
        ORDER BY e.received_at DESC LIMIT 20`,
      [tenantId],
    ),
  ]);
  return {
    enabled: reviewDemoEnabled(),
    disclosure: tiktokReviewPrototypeDisclosure(),
    connection: connection.rows[0] ?? null,
    events: events.rows,
    samples: tiktokReviewSamples,
  };
}

export async function socialOverview(tenantId: string) {
  const [connections, metrics, recent, entitlement, rules] = await Promise.all([
    pool.query(
      `SELECT connection_id,channel_type,display_name,status,external_account_id,capability_snapshot,
              capability_checked_at,last_error_code,updated_at
         FROM channel_connections
        WHERE tenant_id=$1 AND channel_type IN ('douyin','tiktok') AND status<>'disabled'
        ORDER BY channel_type,created_at`,
      [tenantId],
    ),
    pool.query(
      `SELECT COUNT(*)::int total,
              COUNT(*) FILTER(WHERE received_at>=NOW()-INTERVAL '24 hours')::int last_24h,
              COUNT(*) FILTER(WHERE category='spam')::int spam,
              COUNT(*) FILTER(WHERE category='generic_interaction')::int generic_interaction,
              COUNT(*) FILTER(WHERE category IN ('purchase_intent','pre_sale_question'))::int commercial_intent,
              COUNT(*) FILTER(WHERE category='after_sales')::int after_sales,
              COUNT(*) FILTER(WHERE category IN ('complaint_risk','public_crisis'))::int risk,
              COUNT(*) FILTER(WHERE route='manual_review')::int manual_review
         FROM (
           SELECT e.received_at,COALESCE(x.corrected_category,c.category) AS category,
                  COALESCE(x.corrected_route,r.route) AS route
             FROM social_events e
             LEFT JOIN social_classifications c ON c.social_event_id=e.social_event_id
             LEFT JOIN social_routing_decisions r ON r.social_event_id=e.social_event_id
             LEFT JOIN LATERAL (
               SELECT corrected_category,corrected_route FROM social_classification_corrections correction
                WHERE correction.tenant_id=e.tenant_id AND correction.social_event_id=e.social_event_id
                ORDER BY correction.created_at DESC,correction.correction_id DESC LIMIT 1
             ) x ON TRUE
            WHERE e.tenant_id=$1
         ) effective`,
      [tenantId],
    ),
    pool.query(
      `SELECT e.social_event_id,e.provider,e.event_type,LEFT(e.content,500) content,e.video_id,e.comment_id,e.occurred_at,
              c.category AS original_category,COALESCE(correction.corrected_category,c.category) AS category,
              c.confidence,c.source,c.reason_codes,
              COALESCE(correction.corrected_route,r.route) AS route,
              COALESCE(correction.corrected_priority,r.priority) AS priority,
              r.requires_human,r.action_gate,correction.correction_id,correction.reason AS correction_reason,
              COALESCE(state.resulting_state,'pending') AS case_status
         FROM social_events e
         JOIN social_classifications c ON c.social_event_id=e.social_event_id
         JOIN social_routing_decisions r ON r.social_event_id=e.social_event_id
         LEFT JOIN LATERAL (
           SELECT correction_id,corrected_category,corrected_route,corrected_priority,reason
             FROM social_classification_corrections x
            WHERE x.tenant_id=e.tenant_id AND x.social_event_id=e.social_event_id
            ORDER BY x.created_at DESC,x.correction_id DESC LIMIT 1
         ) correction ON TRUE
         LEFT JOIN LATERAL (
           SELECT resulting_state FROM social_case_actions a
            WHERE a.tenant_id=e.tenant_id AND a.social_event_id=e.social_event_id
            ORDER BY a.created_at DESC,a.action_id DESC LIMIT 1
         ) state ON TRUE
        WHERE e.tenant_id=$1 AND (r.route IN ('chatwoot_case','manual_review','escalate') OR correction.correction_id IS NOT NULL)
          AND COALESCE(state.resulting_state,'pending')<>'resolved'
        ORDER BY CASE COALESCE(correction.corrected_priority,r.priority) WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,e.received_at DESC
        LIMIT 50`,
      [tenantId],
    ),
    effectiveEntitlement(tenantId),
    listSocialRules(tenantId),
  ]);
  const features = new Set(entitlement.entitlements.features);
  return {
    execution_enabled: false,
    provider_mode: "synthetic_only",
    connections: connections.rows,
    metrics: metrics.rows[0] ?? { total: 0, last_24h: 0, spam: 0, generic_interaction: 0, commercial_intent: 0, after_sales: 0, risk: 0, manual_review: 0 },
    queue: recent.rows,
    rules,
    entitlements: {
      direct_messages: features.has("social.direct_messages"),
      comment_management: features.has("social.comment_management"),
      ai_classification: features.has("social.ai_classification"),
      comment_to_message: features.has("social.comment_to_message"),
    },
  };
}

export async function socialQualityReport(tenantId: string, rawDays: unknown = 30) {
  type QualityCounts = { classified: number; reviewed: number; confirmed: number; corrected: number };
  const days = validateSocialQualityWindow(rawDays);
  const scopedCte = `WITH scoped AS (
      SELECT e.social_event_id,e.provider,c.category AS machine_category,c.source,c.matched_rule_id,c.classifier_version,
             evaluation.evaluated_category,evaluation.outcome
        FROM social_events e JOIN social_classifications c ON c.social_event_id=e.social_event_id
        LEFT JOIN LATERAL (
          SELECT x.evaluated_category,x.outcome FROM social_classification_evaluations x
           WHERE x.tenant_id=e.tenant_id AND x.social_event_id=e.social_event_id
           ORDER BY x.created_at DESC,x.evaluation_id DESC LIMIT 1
        ) evaluation ON TRUE
       WHERE e.tenant_id=$1 AND c.created_at>=NOW()-make_interval(days=>$2::int)
    )`;
  const [summary, categories, confusions, rules] = await Promise.all([
    pool.query<QualityCounts>(`${scopedCte}
      SELECT COUNT(*)::int classified,COUNT(outcome)::int reviewed,
             COUNT(*) FILTER(WHERE outcome='confirmed')::int confirmed,
             COUNT(*) FILTER(WHERE outcome='corrected')::int corrected
        FROM scoped`, [tenantId, days]),
    pool.query(`${scopedCte}
      SELECT provider,source,machine_category,COUNT(*)::int classified,COUNT(outcome)::int reviewed,
             COUNT(*) FILTER(WHERE outcome='confirmed')::int confirmed,
             COUNT(*) FILTER(WHERE outcome='corrected')::int corrected
        FROM scoped GROUP BY provider,source,machine_category ORDER BY classified DESC,provider,source,machine_category`, [tenantId, days]),
    pool.query(`${scopedCte}
      SELECT machine_category,evaluated_category,COUNT(*)::int count
        FROM scoped WHERE outcome='corrected'
       GROUP BY machine_category,evaluated_category ORDER BY count DESC,machine_category,evaluated_category LIMIT 20`, [tenantId, days]),
    pool.query(`${scopedCte}
      SELECT r.rule_id,r.name,r.status,COUNT(s.social_event_id)::int matched,COUNT(s.outcome)::int reviewed,
             COUNT(*) FILTER(WHERE s.outcome='confirmed')::int confirmed,
             COUNT(*) FILTER(WHERE s.outcome='corrected')::int corrected
        FROM social_tenant_rules r LEFT JOIN scoped s ON s.matched_rule_id=r.rule_id::text
       WHERE r.tenant_id=$1 GROUP BY r.rule_id,r.name,r.status ORDER BY matched DESC,r.name`, [tenantId, days]),
  ]);
  const decorate = <T extends { reviewed: number; confirmed: number }>(row: T): T & { observed_accuracy: number | null } => {
    const reviewed = Number(row.reviewed ?? 0);
    const confirmed = Number(row.confirmed ?? 0);
    return { ...row, observed_accuracy: socialObservedRate(confirmed, reviewed) };
  };
  const totals = decorate(summary.rows[0] ?? { classified: 0, reviewed: 0, confirmed: 0, corrected: 0 });
  return {
    window_days: days,
    generated_at: new Date().toISOString(),
    sample_definition: "latest_human_evaluation_per_event",
    totals: { ...totals, review_coverage: socialObservedRate(Number(totals.reviewed), Number(totals.classified)) },
    categories: categories.rows.map(decorate),
    confusions: confusions.rows,
    rules: rules.rows.map(decorate),
  };
}

export async function handleSocialChannelApi(request: IncomingMessage, response: ServerResponse, url: URL, auth: Auth, requestId: string): Promise<boolean> {
  if (!url.pathname.startsWith("/api/v1/social")) return false;
  if (auth.role === "agent") {
    sendJson(response, 403, { request_id: requestId, error: { code: "forbidden" } });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/social/overview") {
    sendJson(response, 200, { request_id: requestId, data: await socialOverview(auth.tenant_id) });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/social/demo/tiktok") {
    sendJson(response, 200, { request_id: requestId, data: await tiktokReviewDemo(auth.tenant_id) });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/social/demo/tiktok/session") {
    if (auth.role !== "tenant_admin") {
      sendJson(response, 403, { request_id: requestId, error: { code: "admin_required" } });
      return true;
    }
    try {
      if (!reviewDemoEnabled()) throw new Error("social_review_demo_disabled");
      const connection = await ensureTikTokReviewConnection(auth, requestId);
      sendJson(response, 201, { request_id: requestId, data: { connection, disclosure: tiktokReviewPrototypeDisclosure() } });
    } catch (error) {
      apiError(response, requestId, error);
    }
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/social/demo/tiktok/events") {
    if (auth.role !== "tenant_admin") {
      sendJson(response, 403, { request_id: requestId, error: { code: "admin_required" } });
      return true;
    }
    try {
      if (!reviewDemoEnabled()) throw new Error("social_review_demo_disabled");
      const input = validateTikTokReviewEvent(await jsonInput(request));
      const connection = await ensureTikTokReviewConnection(auth, requestId);
      const fixture = createTikTokReviewMockEvent({
        channel_connection_id: connection.connection_id,
        external_account_id: connection.external_account_id,
        event_type: input.event_type,
        content: input.content,
      });
      const result = await ingestSocialEvent({
        tenant_id: auth.tenant_id,
        event: fixture.event,
        entitlements: ["social.direct_messages", "social.comment_management", "social.ai_classification", "social.comment_to_message"],
        user_authorized: true,
        reply_window_open: true,
        notification_delivery_mode: "in_app_only",
      });
      await pool.query(
        `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
         VALUES($1,$2,$3,'social.tiktok_review_event_injected','social_event',$4,$5,$6)`,
        [auth.tenant_id, auth.auth_kind, auth.actor_id, result.social_event_id, JSON.stringify({ event_type: input.event_type, synthetic: true, network_calls: 0, provider_writes: 0, category: result.classification.category, route: result.route.route }), requestId],
      );
      sendJson(response, 201, { request_id: requestId, data: { ...result, disclosure: fixture.disclosure } });
    } catch (error) {
      apiError(response, requestId, error);
    }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/social/quality") {
    try {
      sendJson(response, 200, { request_id: requestId, data: await socialQualityReport(auth.tenant_id, url.searchParams.get("days")) });
    } catch (error) {
      apiError(response, requestId, error);
    }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/social/rules") {
    sendJson(response, 200, { request_id: requestId, data: await listSocialRules(auth.tenant_id) });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/social/rules") {
    if (auth.role !== "tenant_admin") {
      sendJson(response, 403, { request_id: requestId, error: { code: "admin_required" } });
      return true;
    }
    try {
      const data = await createSocialRule({ tenant_id: auth.tenant_id, body: await jsonInput(request), actor: actor(auth), request_id: requestId });
      sendJson(response, 201, { request_id: requestId, data });
    } catch (error) {
      apiError(response, requestId, error);
    }
    return true;
  }
  const rule = url.pathname.match(/^\/api\/v1\/social\/rules\/([0-9a-f-]{36})$/i);
  if (request.method === "PUT" && rule) {
    if (auth.role !== "tenant_admin") {
      sendJson(response, 403, { request_id: requestId, error: { code: "admin_required" } });
      return true;
    }
    try {
      const body = await jsonInput(request);
      const data = await updateSocialRule({
        tenant_id: auth.tenant_id,
        rule_id: rule[1],
        expected_version: Number(body.expected_version),
        body,
        actor: actor(auth),
        request_id: requestId,
      });
      sendJson(response, 200, { request_id: requestId, data });
    } catch (error) {
      apiError(response, requestId, error);
    }
    return true;
  }
  const correction = url.pathname.match(/^\/api\/v1\/social\/events\/([0-9a-f-]{36})\/corrections$/i);
  if (request.method === "POST" && correction) {
    try {
      const body = await jsonInput(request);
      const data = await correctSocialClassification({
        tenant_id: auth.tenant_id,
        social_event_id: correction[1],
        category: body.category,
        reason: body.reason,
        actor: actor(auth),
        request_id: requestId,
      });
      sendJson(response, 201, { request_id: requestId, data });
    } catch (error) {
      apiError(response, requestId, error);
    }
    return true;
  }
  const evaluation = url.pathname.match(/^\/api\/v1\/social\/events\/([0-9a-f-]{36})\/evaluations$/i);
  if (request.method === "POST" && evaluation) {
    try {
      const body = await jsonInput(request);
      const data = await confirmSocialClassification({
        tenant_id: auth.tenant_id,
        social_event_id: evaluation[1],
        reason: body.reason,
        actor: actor(auth),
        request_id: requestId,
      });
      sendJson(response, 201, { request_id: requestId, data });
    } catch (error) {
      apiError(response, requestId, error);
    }
    return true;
  }
  const action = url.pathname.match(/^\/api\/v1\/social\/events\/([0-9a-f-]{36})\/actions$/i);
  if (request.method === "POST" && action) {
    try {
      const body = await jsonInput(request);
      const data = await recordSocialCaseAction({
        tenant_id: auth.tenant_id,
        social_event_id: action[1],
        action: String(body.action ?? "") as SocialCaseAction,
        reason: body.reason,
        actor: actor(auth),
        request_id: requestId,
      });
      sendJson(response, 201, { request_id: requestId, data });
    } catch (error) {
      apiError(response, requestId, error);
    }
    return true;
  }
  sendJson(response, 404, { request_id: requestId, error: { code: "not_found" } });
  return true;
}
