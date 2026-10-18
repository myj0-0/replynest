import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import {
  deliveryRetrySeconds,
  externalDeliveryAllowed,
  inQuietHours,
  meetsMinimumSeverity,
  safeNotificationText,
  type NotificationChannel,
  type NotificationPreference,
  type NotificationSeverity,
  validDedupeKey,
} from "./notification-core.js";
import { postJson } from "./shared.js";
import { decryptWebhookSecret } from "./notification-webhook-crypto.js";
import { sendNotificationWebhook, type WebhookProvider } from "./notification-webhook-adapter.js";
import { sendBrowserPush } from "./browser-push.js";
import { browserPushConfig } from "./browser-push-core.js";
import {notificationMediaMetadata} from './wechat-media-core.js';
import {claimNotificationWebhook,finishNotificationWebhook,queueNotificationWebhookTest,webhookFailure,WEBHOOK_MAX_ATTEMPTS,WEBHOOK_TEST_EVENT} from './notification-webhook-retry.js';

export type EmitNotificationInput = {
  tenant_id: string;
  event_type: string;
  severity: NotificationSeverity;
  title: string;
  summary: string;
  dedupe_key: string;
  resource_type?: string;
  resource_id?: string;
  metadata?: Record<string, string | number | boolean | null>;
  actor_type?: string;
  actor_id?: string;
  request_id?: string;
  requires_action?: boolean;
  webhook_scope?: "system" | "message" | "unattended";
  delivery_mode?: "configured" | "in_app_only";
};

type EventRow = {
  notification_id: string;
  tenant_id: string;
  severity: NotificationSeverity;
  title: string;
  summary: string;
  event_type: string;
  requires_action: boolean;
  last_occurred_at: string;
  metadata: Record<string, unknown>;
  inserted: boolean;
  occurrence_count: number;
};

type PreferenceRow = {
  channels: NotificationChannel[];
  minimum_external_severity: NotificationSeverity;
  quiet_hours_start: string;
  quiet_hours_end: string;
  timezone: string;
  escalation_minutes: number;
  message_notification_mode: "off" | "every_message" | "unattended" | "both";
  unattended_minutes: number;
  include_message_preview: boolean;
};

function normalizedPreference(row: PreferenceRow): NotificationPreference {
  return {
    channels: row.channels,
    minimum_external_severity: row.minimum_external_severity,
    quiet_hours_start: String(row.quiet_hours_start).slice(0, 5),
    quiet_hours_end: String(row.quiet_hours_end).slice(0, 5),
    timezone: row.timezone,
    escalation_minutes: Number(row.escalation_minutes),
    message_notification_mode: row.message_notification_mode,
    unattended_minutes: Number(row.unattended_minutes),
    include_message_preview: row.include_message_preview,
  };
}

export async function notificationPreference(tenantId: string): Promise<NotificationPreference> {
  const result = await pool.query<PreferenceRow>(
    `SELECT COALESCE(p.channels,ARRAY['in_app','chatwoot']::TEXT[]) AS channels,
            COALESCE(p.minimum_external_severity,'warning') AS minimum_external_severity,
            COALESCE(p.quiet_hours_start,'22:00'::time)::text AS quiet_hours_start,
            COALESCE(p.quiet_hours_end,'08:00'::time)::text AS quiet_hours_end,
            COALESCE(p.timezone,t.timezone) AS timezone,
            COALESCE(p.escalation_minutes,15) AS escalation_minutes
            ,COALESCE(p.message_notification_mode,'unattended') AS message_notification_mode
            ,COALESCE(p.unattended_minutes,10) AS unattended_minutes
            ,COALESCE(p.include_message_preview,FALSE) AS include_message_preview
       FROM tenants t LEFT JOIN notification_preferences p ON p.tenant_id=t.tenant_id
      WHERE t.tenant_id=$1`,
    [tenantId],
  );
  if (!result.rows[0]) throw new Error("Notification tenant was not found");
  return normalizedPreference(result.rows[0]);
}

function enterpriseWechatMode(): "off" | "dry_run" {
  return process.env.ENTERPRISE_WECHAT_NOTIFICATION_MODE === "dry_run" ? "dry_run" : "off";
}

function safeMetadata(input: EmitNotificationInput["metadata"]): Record<string, string | number | boolean | null> {
  const allowed = new Set(["chatwoot_conversation_id", "failure_code", "synthetic", "source"]);
  return {...Object.fromEntries(Object.entries(input ?? {}).filter(([key, value]) =>
    allowed.has(key) && (value === null || ["string", "number", "boolean"].includes(typeof value))
  )),...notificationMediaMetadata(input)};
}

async function dispatchChatwoot(deliveryId: string, event: EventRow): Promise<void> {
  const conversationId = String(event.metadata.chatwoot_conversation_id ?? "");
  if (!/^\d+$/.test(conversationId)) {
    await pool.query(
      `UPDATE notification_deliveries SET status='suppressed',error_code='conversation_not_available',updated_at=NOW()
        WHERE delivery_id=$1`,
      [deliveryId],
    );
    return;
  }
  const tenant = await pool.query<{ chatwoot_account_id: string }>(
    `SELECT chatwoot_account_id FROM tenants WHERE tenant_id=$1 AND chatwoot_account_id IS NOT NULL`,
    [event.tenant_id],
  );
  const accountId = tenant.rows[0]?.chatwoot_account_id;
  const baseUrl = process.env.CHATWOOT_BASE_URL;
  const token = process.env.CHATWOOT_API_ACCESS_TOKEN;
  if (!accountId || !baseUrl || !token) throw new Error("chatwoot_not_configured");
  await postJson(
    `${baseUrl.replace(/\/$/, "")}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
    { content: `【ReplyNest ${event.severity === "critical" ? "紧急" : "提醒"}】${event.title}\n${event.summary}`, message_type: "outgoing", private: true },
    { api_access_token: token, "x-forwarded-proto": "https" },
  );
  await pool.query(
    `UPDATE notification_deliveries SET status='delivered',attempt_count=attempt_count+1,
        delivered_at=NOW(),next_attempt_at=NULL,error_code=NULL,updated_at=NOW() WHERE delivery_id=$1`,
    [deliveryId],
  );
}

async function dispatchWebhook(deliveryId: string, targetRef: string, event: EventRow): Promise<void> {
  const attempt = await claimNotificationWebhook(pool, deliveryId, event.tenant_id);
  if (attempt === null) return;
  const destination = await pool.query<{
      provider: WebhookProvider; endpoint_ciphertext: string; signing_secret_ciphertext: string | null;
    }>(`SELECT provider,endpoint_ciphertext,signing_secret_ciphertext FROM notification_webhook_destinations
        WHERE destination_id=$1 AND tenant_id=$2 AND status='active'`, [targetRef, event.tenant_id]);
  const row = destination.rows[0];
  if (!row) {
      await finishNotificationWebhook(pool, deliveryId, event.tenant_id, attempt, 'suppressed', 'destination_unavailable');
    return;
  }
  let status:'delivered'|'pending'|'failed'='delivered';
  let errorCode:string|null=null;
  try {
    await sendNotificationWebhook({
      provider: row.provider, endpoint: decryptWebhookSecret(row.endpoint_ciphertext),
      signing_secret: row.signing_secret_ciphertext ? decryptWebhookSecret(row.signing_secret_ciphertext) : undefined,
      event_id: event.notification_id, severity: event.severity, title: event.title, summary: event.summary,
      occurred_at: event.last_occurred_at,
      media: {message_type:event.metadata.message_type,attachment_count:event.metadata.attachment_count,view_path:event.metadata.media_view_path,attachment_id:event.metadata.media_attachment_id,processing_status:event.metadata.media_status} as import('./wechat-media-core.js').MessageMediaNotice,
    });
  } catch (error) {
    const failure = webhookFailure(error,row.provider);
    status=failure.retryable && attempt < WEBHOOK_MAX_ATTEMPTS ? 'pending' : 'failed';
    errorCode=failure.code;
    console.warn('Notification webhook attempt failed', {attempt, error_code: failure.code});
  }
  // Database uncertainty is not misclassified as a permanent provider/configuration error.
  await finishNotificationWebhook(pool, deliveryId, event.tenant_id, attempt,status,errorCode);
}
async function dispatchDelivery(delivery: { delivery_id: string; channel: NotificationChannel; target_ref?: string; attempt_count: number }, event: EventRow): Promise<void> {
  if (delivery.channel === "in_app") return;
  if (delivery.channel === "webhook") {
    await dispatchWebhook(delivery.delivery_id, String(delivery.target_ref ?? ""), event);
    return;
  }
  if (delivery.channel === "enterprise_wechat") {
    const mode = enterpriseWechatMode();
    await pool.query(
      `UPDATE notification_deliveries SET status=$2,attempt_count=attempt_count+1,
          delivered_at=CASE WHEN $2='dry_run' THEN NOW() ELSE NULL END,
          error_code=CASE WHEN $2='suppressed' THEN 'provider_live_disabled' ELSE NULL END,updated_at=NOW()
        WHERE delivery_id=$1`,
      [delivery.delivery_id, mode === "dry_run" ? "dry_run" : "suppressed"],
    );
    return;
  }
  try {
    if (delivery.channel === "browser_push") {
      const outcome = await sendBrowserPush(String(delivery.target_ref ?? ""), event.tenant_id, {
        title: event.title, summary: event.summary, severity: event.severity, notification_id: event.notification_id,
      });
      await pool.query(
        `UPDATE notification_deliveries SET status=$2,attempt_count=attempt_count+1,delivered_at=CASE WHEN $2='delivered' THEN NOW() ELSE NULL END,
          next_attempt_at=NULL,error_code=CASE WHEN $2='suppressed' THEN 'subscription_expired' ELSE NULL END,updated_at=NOW() WHERE delivery_id=$1`,
        [delivery.delivery_id, outcome === "delivered" ? "delivered" : "suppressed"],
      );
    }
    else await dispatchChatwoot(delivery.delivery_id, event);
  } catch (error) {
    const nextAttempt = Number(delivery.attempt_count) + 1;
    const exhausted = nextAttempt >= 5;
    await pool.query(
      `UPDATE notification_deliveries SET status=$2,attempt_count=$3,
          next_attempt_at=CASE WHEN $2='pending' THEN NOW()+make_interval(secs=>$4) ELSE NULL END,
          error_code='provider_unavailable',updated_at=NOW() WHERE delivery_id=$1`,
      [delivery.delivery_id, exhausted ? "failed" : "pending", nextAttempt, deliveryRetrySeconds(nextAttempt)],
    );
    console.warn("Notification delivery failed", { channel: delivery.channel, error: error instanceof Error ? error.message : "unknown" });
  }
}

export async function emitNotification(input: EmitNotificationInput): Promise<{ notification_id: string; duplicate: boolean; occurrence_count: number }> {
  if (!validDedupeKey(input.dedupe_key)) throw new Error("Invalid notification dedupe key");
  if (!/^[a-z][a-z0-9_.-]{2,100}$/.test(input.event_type)) throw new Error("Invalid notification event type");
  if (!['info', 'warning', 'critical'].includes(input.severity)) throw new Error("Invalid notification severity");
  const title = safeNotificationText(input.title, 160);
  const summary = safeNotificationText(input.summary, 500);
  const metadata = safeMetadata(input.metadata);
  const requestId = input.request_id ?? randomUUID();
  const client = await pool.connect();
  let event!: EventRow;
  let deliveries: Array<{ delivery_id: string; channel: NotificationChannel; target_ref?: string; attempt_count: number }> = [];
  const webhookScope = input.webhook_scope ?? "system";
  try {
    await client.query("BEGIN");
    const preferenceResult = await client.query<PreferenceRow>(
      `SELECT COALESCE(p.channels,ARRAY['in_app','chatwoot']::TEXT[]) AS channels,
              COALESCE(p.minimum_external_severity,'warning') AS minimum_external_severity,
              COALESCE(p.quiet_hours_start,'22:00'::time)::text AS quiet_hours_start,
              COALESCE(p.quiet_hours_end,'08:00'::time)::text AS quiet_hours_end,
              COALESCE(p.timezone,t.timezone) AS timezone,
              COALESCE(p.escalation_minutes,15) AS escalation_minutes
              ,COALESCE(p.message_notification_mode,'unattended') AS message_notification_mode
              ,COALESCE(p.unattended_minutes,10) AS unattended_minutes
              ,COALESCE(p.include_message_preview,FALSE) AS include_message_preview
         FROM tenants t LEFT JOIN notification_preferences p ON p.tenant_id=t.tenant_id
        WHERE t.tenant_id=$1 FOR UPDATE OF t`,
      [input.tenant_id],
    );
    if (!preferenceResult.rows[0]) throw new Error("Notification tenant was not found");
    const preference = normalizedPreference(preferenceResult.rows[0]);
    const inserted = await client.query<EventRow>(
      `INSERT INTO notification_events
        (tenant_id,event_type,severity,title,summary,resource_type,resource_id,dedupe_key,metadata,status,requires_action,resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $10 THEN 'open' ELSE 'resolved' END,$10,
               CASE WHEN $10 THEN NULL ELSE NOW() END)
       ON CONFLICT (tenant_id,dedupe_key) WHERE status IN ('open','acknowledged')
       DO UPDATE SET occurrence_count=notification_events.occurrence_count+1,
          last_occurred_at=NOW(),updated_at=NOW(),summary=EXCLUDED.summary,
          severity=CASE
            WHEN notification_events.severity='critical' OR EXCLUDED.severity='critical' THEN 'critical'
            WHEN notification_events.severity='warning' OR EXCLUDED.severity='warning' THEN 'warning'
            ELSE 'info' END
       RETURNING notification_id,tenant_id,event_type,severity,title,summary,metadata,requires_action,
                 last_occurred_at::text,(xmax=0) AS inserted,occurrence_count`,
      [input.tenant_id, input.event_type, input.severity, title, summary, input.resource_type ?? null,
       input.resource_id ?? null, input.dedupe_key, metadata, input.requires_action !== false],
    );
    event = inserted.rows[0];
    if (event.inserted) {
      const preferenceChannels = input.delivery_mode === "in_app_only" ? (["in_app"] as NotificationChannel[]) : webhookScope === "message"
        ? preference.channels.filter(channel => channel === "in_app" || channel === "browser_push")
        : preference.channels;
      const configuredChannels: Array<{ channel: NotificationChannel; target_ref: string }> = [];
      for (const channel of preferenceChannels) {
        if (channel === "browser_push") {
          const subscriptions = await client.query<{ subscription_id: string }>(
            `SELECT subscription_id FROM browser_push_subscriptions WHERE tenant_id=$1 AND status='active' ORDER BY created_at`,
            [input.tenant_id],
          );
          configuredChannels.push(...subscriptions.rows.map(row => ({ channel, target_ref: row.subscription_id })));
        } else {
          configuredChannels.push({ channel, target_ref: channel === "chatwoot" ? String(metadata.chatwoot_conversation_id ?? "tenant") : "tenant" });
        }
      }
      if (webhookScope && input.delivery_mode !== "in_app_only") {
        const destinations = await client.query<{ destination_id: string }>(
          `SELECT destination_id FROM notification_webhook_destinations
            WHERE tenant_id=$1 AND status='active' ORDER BY created_at`,
          [input.tenant_id],
        );
        configuredChannels.push(...destinations.rows.map(row => ({ channel: "webhook" as const, target_ref: row.destination_id })));
      }
      for (const configured of configuredChannels) {
        const channel = configured.channel;
        let status: "pending" | "delivered" | "dry_run" | "suppressed" = "pending";
        let nextAttempt: Date | null = new Date();
        let errorCode: string | null = null;
        if (channel === "in_app") { status = "delivered"; nextAttempt = null; }
        else if (webhookScope === "system" && !meetsMinimumSeverity(event.severity, preference)) {
          status = "suppressed";
          nextAttempt = null;
          errorCode = "severity_below_minimum";
        }
        else if (event.severity !== "critical" && inQuietHours(new Date(), preference)) {
          status = "pending";
          nextAttempt = new Date(Date.now() + 15 * 60_000);
        }
        else if (channel === "enterprise_wechat") {
          status = enterpriseWechatMode() === "dry_run" ? "dry_run" : "suppressed";
          nextAttempt = null;
          errorCode = status === "suppressed" ? "provider_live_disabled" : null;
        }
        else if (channel === "browser_push" && !browserPushConfig().enabled) {
          status = "suppressed";
          nextAttempt = null;
          errorCode = "provider_live_disabled";
        }
        const targetRef = configured.target_ref;
        const delivery = await client.query<{ delivery_id: string; channel: NotificationChannel; target_ref: string; attempt_count: number }>(
          `INSERT INTO notification_deliveries
            (notification_id,tenant_id,channel,target_ref,status,next_attempt_at,delivered_at,error_code)
           VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $5 IN ('delivered','dry_run') THEN NOW() ELSE NULL END,
                   $7)
           RETURNING delivery_id,channel,target_ref,attempt_count`,
          [event.notification_id, input.tenant_id, channel, targetRef, status, nextAttempt, errorCode],
        );
        if (status === "pending" && nextAttempt && nextAttempt.getTime() <= Date.now() + 1000) deliveries.push(delivery.rows[0]);
      }
      await client.query(
        `INSERT INTO audit_logs
          (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
         VALUES ($1,$2,$3,'notification.created','notification',$4,
                 jsonb_build_object('event_type',$5::text,'severity',$6::text,'channels',$7::text[]),$8)`,
        [input.tenant_id, input.actor_type ?? "system", input.actor_id ?? "notification_gateway",
         event.notification_id, input.event_type, input.severity, preference.channels, requestId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  for (const delivery of deliveries) await dispatchDelivery(delivery, event);
  return { notification_id: event.notification_id, duplicate: !event.inserted, occurrence_count: Number(event.occurrence_count) };
}

export async function processPendingNotifications(): Promise<void> {
  const pending = await pool.query<{
    delivery_id: string; channel: NotificationChannel; target_ref: string; attempt_count: number; notification_id: string;
    tenant_id: string; event_type: string; requires_action: boolean; last_occurred_at: string;
    severity: NotificationSeverity; title: string; summary: string; metadata: Record<string, unknown>;
  }>(
    `SELECT d.delivery_id,d.channel,d.target_ref,d.attempt_count,e.notification_id,e.tenant_id,e.event_type,
            e.requires_action,e.last_occurred_at::text,e.severity,e.title,e.summary,e.metadata
       FROM notification_deliveries d JOIN notification_events e ON e.notification_id=d.notification_id
      WHERE d.status='pending' AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=NOW())
        AND (e.status IN ('open','acknowledged') OR e.requires_action=FALSE) ORDER BY d.created_at LIMIT 20`,
  );
  for (const row of pending.rows) {
    const configurationTest = row.event_type === WEBHOOK_TEST_EVENT;
    const preference = await notificationPreference(row.tenant_id);
    const messageEvent=['conversation.inbound.message','conversation.unattended'].includes(row.event_type);
    if (!configurationTest && !messageEvent && !meetsMinimumSeverity(row.severity, preference)) {
      await pool.query(
        `UPDATE notification_deliveries SET status='suppressed',next_attempt_at=NULL,
            error_code='severity_below_minimum',updated_at=NOW() WHERE delivery_id=$1`,
        [row.delivery_id],
      );
      continue;
    }
    if (!configurationTest && !(messageEvent ? row.severity==='critical'||!inQuietHours(new Date(),preference) : externalDeliveryAllowed(row.severity, preference))) {
      await pool.query(`UPDATE notification_deliveries SET next_attempt_at=NOW()+INTERVAL '15 minutes',updated_at=NOW() WHERE delivery_id=$1`, [row.delivery_id]);
      continue;
    }
    await dispatchDelivery(row, { ...row, inserted: false, occurrence_count: 1 });
  }
  const escalated = await pool.query<{ notification_id: string; tenant_id: string }>(
    `UPDATE notification_events e SET severity='critical',escalated_at=NOW(),updated_at=NOW()
       FROM tenants t LEFT JOIN notification_preferences p ON p.tenant_id=t.tenant_id
      WHERE e.tenant_id=t.tenant_id AND e.status='open' AND e.severity='warning' AND e.escalated_at IS NULL
        AND e.last_occurred_at<=NOW()-make_interval(mins=>COALESCE(p.escalation_minutes,15))
      RETURNING e.notification_id,e.tenant_id`,
  );
  for (const row of escalated.rows) {
    await pool.query(
      `INSERT INTO audit_logs
        (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
       VALUES ($1,'system','notification_gateway','notification.escalated','notification',$2,
               '{"severity":"critical"}'::jsonb,$3)`,
      [row.tenant_id, row.notification_id, randomUUID()],
    );
  }
}

export async function testWebhookDestination(tenantId: string, destinationId: string) {
  return queueNotificationWebhookTest(pool, tenantId, destinationId);
}
