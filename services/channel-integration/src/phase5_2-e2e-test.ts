import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { markConversationResponded, processUnattendedConversations, recordInboundAttention } from "./conversation-attention.js";
import { decryptWebhookSecret } from "./notification-webhook-crypto.js";
import { requiredEnv } from "./shared.js";

const baseUrl = `http://127.0.0.1:${process.env.PORT ?? 3001}`;
const demoApiKey = requiredEnv("DEMO_TENANT_API_KEY");
const tenantId = requiredEnv("DEMO_TENANT_ID");

async function call(path: string, token: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  });
  return { response, body: await response.json() as any };
}

const session = await call("/api/v1/auth/demo-session", demoApiKey, { method: "POST" });
const token = String(session.body.data?.token ?? "");
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Could not obtain an admin session");
const marker = randomUUID();
const conversationId = "999999";
const messageId = `phase5.2-${marker}`;
let destinationId = "";

try {
  const created = await call("/api/v1/notification-destinations", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "feishu",
      display_name: `Phase 5.2 ${marker}`,
      endpoint: `https://open.feishu.cn/open-apis/bot/v2/hook/${marker}`,
    }),
  });
  if (created.response.status !== 201) throw new Error(`Destination create failed: ${JSON.stringify(created.body)}`);
  destinationId = String(created.body.data.destination_id);

  const listed = await call("/api/v1/notification-destinations", token);
  const destination = listed.body.data?.find((item: any) => item.destination_id === destinationId);
  if (listed.response.status !== 200 || destination?.endpoint_host !== "open.feishu.cn" || "endpoint" in destination) {
    throw new Error("Destination list exposed or lost endpoint metadata");
  }
  const encrypted = await pool.query(`SELECT endpoint_ciphertext FROM notification_webhook_destinations WHERE destination_id=$1`, [destinationId]);
  if (encrypted.rows[0].endpoint_ciphertext.includes(marker) || !decryptWebhookSecret(encrypted.rows[0].endpoint_ciphertext).includes(marker)) {
    throw new Error("Destination encryption at rest failed");
  }

  const disabled = await call(`/api/v1/notification-destinations/${destinationId}`, token, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ display_name: `Phase 5.2 ${marker}`, status: "disabled" }),
  });
  if (disabled.response.status !== 200 || disabled.body.data?.status !== "disabled") throw new Error("Destination disable failed");

  const removed = await call(`/api/v1/notification-destinations/${destinationId}`, token, { method: "DELETE" });
  if (removed.response.status !== 200 || removed.body.data?.deleted !== true) throw new Error("Disabled destination delete failed");
  const afterDelete = await pool.query(`SELECT 1 FROM notification_webhook_destinations WHERE destination_id=$1`, [destinationId]);
  if (afterDelete.rowCount !== 0) throw new Error("Deleted destination still exists");
  destinationId = "";

  const preferences = await call("/api/v1/notification-preferences", token, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channels: ["in_app", "chatwoot"], minimum_external_severity: "warning", quiet_hours_start: "00:00",
      quiet_hours_end: "00:00", timezone: "Asia/Shanghai", escalation_minutes: 15,
      message_notification_mode: "both", unattended_minutes: 1, include_message_preview: false,
    }),
  });
  if (preferences.response.status !== 200) throw new Error("Message notification preference update failed");

  await recordInboundAttention({ tenant_id: tenantId, conversation_id: conversationId, message_id: messageId, text: "不应外发的客户隐私正文" });
  const activity = await pool.query(
    `SELECT notification_id,summary,status,requires_action FROM notification_events
      WHERE tenant_id=$1 AND event_type='conversation.inbound.message' AND resource_id=$2 ORDER BY created_at DESC LIMIT 1`,
    [tenantId, conversationId],
  );
  if (activity.rows[0]?.summary.includes("客户隐私正文") || activity.rows[0]?.status !== "resolved" || activity.rows[0]?.requires_action !== false) {
    throw new Error("Every-message privacy or lifecycle policy failed");
  }
  const activityDeliveries = await pool.query(`SELECT channel FROM notification_deliveries WHERE notification_id=$1`, [activity.rows[0].notification_id]);
  if (activityDeliveries.rows.some(row => row.channel === "chatwoot")) throw new Error("Every-message alert created a redundant Chatwoot note");

  await pool.query(`UPDATE conversation_attention SET last_inbound_at=NOW()-INTERVAL '2 minutes' WHERE tenant_id=$1 AND chatwoot_conversation_id=$2`, [tenantId, conversationId]);
  await processUnattendedConversations();
  const unattended = await pool.query(
    `SELECT notification_id,status,severity FROM notification_events
      WHERE tenant_id=$1 AND event_type='conversation.unattended' AND resource_id=$2 ORDER BY created_at DESC LIMIT 1`,
    [tenantId, conversationId],
  );
  if (unattended.rows[0]?.status !== "open" || unattended.rows[0]?.severity !== "warning") throw new Error("Unattended notification was not created");
  await markConversationResponded(tenantId, conversationId);
  const resolved = await pool.query(`SELECT status FROM notification_events WHERE notification_id=$1`, [unattended.rows[0].notification_id]);
  if (resolved.rows[0]?.status !== "resolved") throw new Error("Agent reply did not auto-resolve the unattended notification");

  console.log("Phase 5.2 E2E passed: encrypted destinations, disabled-only deletion, message policy, privacy default, unattended detection and reply resolution");
} finally {
  await pool.query(`DELETE FROM conversation_attention WHERE tenant_id=$1 AND chatwoot_conversation_id=$2`, [tenantId, conversationId]);
  const events = await pool.query(`SELECT notification_id FROM notification_events WHERE tenant_id=$1 AND resource_id=$2`, [tenantId, conversationId]);
  for (const event of events.rows) {
    await pool.query(`DELETE FROM notification_receipts WHERE notification_id=$1`, [event.notification_id]);
    await pool.query(`DELETE FROM notification_deliveries WHERE notification_id=$1`, [event.notification_id]);
    await pool.query(`DELETE FROM notification_events WHERE notification_id=$1`, [event.notification_id]);
  }
  if (destinationId) await pool.query(`DELETE FROM notification_webhook_destinations WHERE destination_id=$1`, [destinationId]);
  await pool.query(`DELETE FROM notification_preferences WHERE tenant_id=$1`, [tenantId]);
  await pool.query(`UPDATE console_sessions SET revoked_at=COALESCE(revoked_at,NOW()),revoke_reason=COALESCE(revoke_reason,'test_cleanup') WHERE token_hash=encode(digest($1,'sha256'),'hex')`, [token]);
  await pool.end();
}
