import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { processPendingNotifications } from "./notification-gateway.js";
import { requiredEnv } from "./shared.js";

const baseUrl = `http://127.0.0.1:${process.env.PORT ?? 3001}`;
const demoApiKey = requiredEnv("DEMO_TENANT_API_KEY");

async function call(path: string, token: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json() as any;
  return { response, body };
}

const session = await call("/api/v1/auth/demo-session", demoApiKey, { method: "POST" });
const token = String(session.body.data?.token ?? "");
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Could not obtain the admin Console session");
const marker = `phase5.1:${randomUUID()}`;
const notificationIds: string[] = [];

try {
  const preferences = await call("/api/v1/notification-preferences", token, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channels: ["in_app", "enterprise_wechat"],
      minimum_external_severity: "warning",
      quiet_hours_start: "00:00",
      quiet_hours_end: "00:00",
      timezone: "Asia/Shanghai",
      escalation_minutes: 15,
    }),
  });
  if (preferences.response.status !== 200) throw new Error("Notification preference update failed");

  const first = await call("/api/v1/notifications/synthetic", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ severity: "warning", dedupe_key: marker, title: "Phase 5.1 合成通知", summary: "不包含真实客户数据。" }),
  });
  if (first.response.status !== 201 || first.body.data?.duplicate !== false) {
    throw new Error(`Synthetic notification was not created: HTTP ${first.response.status} ${JSON.stringify(first.body)}`);
  }
  const notificationId = String(first.body.data.notification_id);
  notificationIds.push(notificationId);

  const duplicate = await call("/api/v1/notifications/synthetic", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ severity: "warning", dedupe_key: marker, title: "Phase 5.1 合成通知", summary: "重复事件应合并。" }),
  });
  if (duplicate.response.status !== 200 || duplicate.body.data?.duplicate !== true || duplicate.body.data?.occurrence_count !== 2) throw new Error("Notification deduplication failed");

  const listed = await call("/api/v1/notifications?status=active&limit=100", token);
  const item = listed.body.data?.find((value: any) => value.notification_id === notificationId);
  if (listed.response.status !== 200 || item?.occurrence_count !== 2) throw new Error("Notification list did not return the coalesced event");
  if (!item.deliveries?.some((value: any) => value.channel === "in_app" && value.status === "delivered")) throw new Error("In-app delivery was not recorded");
  if (!item.deliveries?.some((value: any) => value.channel === "enterprise_wechat" && value.status === "dry_run")) throw new Error("Enterprise WeChat dry run was not recorded");

  const belowMinimum = await call("/api/v1/notifications/synthetic", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ severity: "info", dedupe_key: `${marker}:below-minimum`, title: "Phase 5.1 低优先级通知", summary: "外部渠道应按阈值抑制。" }),
  });
  if (belowMinimum.response.status !== 201) throw new Error("Below-minimum notification was not created");
  const belowMinimumId = String(belowMinimum.body.data.notification_id);
  notificationIds.push(belowMinimumId);
  const suppressed = await call("/api/v1/notifications?status=active&limit=100", token);
  const suppressedItem = suppressed.body.data?.find((value: any) => value.notification_id === belowMinimumId);
  if (!suppressedItem?.deliveries?.some((value: any) => value.channel === "enterprise_wechat" && value.status === "suppressed")) {
    throw new Error("Below-minimum external delivery was not suppressed");
  }

  const read = await call(`/api/v1/notifications/${notificationId}/read`, token, { method: "POST" });
  if (read.response.status !== 200) throw new Error("Notification read receipt failed");
  const acknowledged = await call(`/api/v1/notifications/${notificationId}/acknowledge`, token, { method: "POST" });
  if (acknowledged.response.status !== 200 || acknowledged.body.data?.status !== "acknowledged") throw new Error("Notification acknowledgement failed");
  const resolved = await call(`/api/v1/notifications/${notificationId}/resolve`, token, { method: "POST" });
  if (resolved.response.status !== 200 || resolved.body.data?.status !== "resolved") throw new Error("Notification resolution failed");

  const active = await call("/api/v1/notifications?status=active&limit=100", token);
  if (active.body.data?.some((value: any) => value.notification_id === notificationId)) throw new Error("Resolved notification remained active");

  await pool.query(`DELETE FROM notification_preferences WHERE tenant_id=$1`, [requiredEnv("DEMO_TENANT_ID")]);
  const defaultEscalation = await call("/api/v1/notifications/synthetic", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ severity: "warning", dedupe_key: `${marker}:default-escalation`, title: "Phase 5.1 默认升级", summary: "未保存偏好时也应采用默认升级时限。" }),
  });
  if (defaultEscalation.response.status !== 201) throw new Error("Default-escalation notification was not created");
  const defaultEscalationId = String(defaultEscalation.body.data.notification_id);
  notificationIds.push(defaultEscalationId);
  await pool.query(`UPDATE notification_events SET last_occurred_at=NOW()-INTERVAL '16 minutes' WHERE notification_id=$1`, [defaultEscalationId]);
  await processPendingNotifications();
  const escalated = await pool.query(`SELECT severity,escalated_at FROM notification_events WHERE notification_id=$1`, [defaultEscalationId]);
  if (escalated.rows[0]?.severity !== "critical" || !escalated.rows[0]?.escalated_at) throw new Error("Default escalation policy was not applied");

  console.log("Phase 5.1 E2E passed: preferences, dedupe, thresholds, in-app delivery, enterprise WeChat dry run, read, acknowledge, resolve and default escalation");
} finally {
  for (const notificationId of notificationIds) {
    await pool.query(`DELETE FROM notification_receipts WHERE notification_id=$1`, [notificationId]);
    await pool.query(`DELETE FROM notification_deliveries WHERE notification_id=$1`, [notificationId]);
    await pool.query(`DELETE FROM notification_events WHERE notification_id=$1`, [notificationId]);
  }
  await pool.query(`DELETE FROM notification_preferences WHERE tenant_id=$1`, [requiredEnv("DEMO_TENANT_ID")]);
  await pool.query(`UPDATE console_sessions SET revoked_at=COALESCE(revoked_at,NOW()),revoke_reason=COALESCE(revoke_reason,'test_cleanup') WHERE token_hash=encode(digest($1,'sha256'),'hex')`, [token]);
  await pool.end();
}
