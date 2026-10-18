import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "./database.js";
import { emitNotification, notificationPreference } from "./notification-gateway.js";
import { safeNotificationText, validDedupeKey, validatePreference, type NotificationSeverity } from "./notification-core.js";
import { readBody, sendJson } from "./shared.js";

type NotificationAuth = {
  tenant_id: string;
  tenant_status: string;
  role: "tenant_admin" | "supervisor" | "agent";
  actor_id: string;
  auth_kind: "api_key" | "console_session";
  platform_user_id: string | null;
};

function result(response: ServerResponse, status: number, requestId: string, body: Record<string, unknown>) {
  sendJson(response, status, { request_id: requestId, ...body });
}

function allowed(auth: NotificationAuth): boolean {
  return auth.role === "tenant_admin" || auth.role === "supervisor";
}

async function jsonInput(request: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const input = JSON.parse((await readBody(request)).toString("utf8"));
    if (!input || Array.isArray(input) || typeof input !== "object") throw new Error();
    return input as Record<string, unknown>;
  } catch {
    throw new Error("invalid_json");
  }
}

export async function handleNotificationsApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  auth: NotificationAuth,
  requestId: string,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/v1/notifications") && url.pathname !== "/api/v1/notification-preferences") return false;
  if (!allowed(auth)) {
    result(response, 403, requestId, { error: { code: "insufficient_role", message: "仅管理员或主管可以查看运营通知" } });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/notifications") {
    const requestedStatus = url.searchParams.get("status") ?? "active";
    const statusClause = requestedStatus === "all" ? "TRUE" : "e.status IN ('open','acknowledged')";
    const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 50;
    const notifications = await pool.query(
      `SELECT e.notification_id,e.event_type,e.severity,e.title,e.summary,e.resource_type,e.resource_id,
              e.status,e.occurrence_count,e.first_occurred_at,e.last_occurred_at,e.acknowledged_at,e.escalated_at,
              (r.read_at IS NOT NULL) AS is_read,
              COALESCE(jsonb_agg(jsonb_build_object('channel',d.channel,'status',d.status,'attempt_count',d.attempt_count,'next_attempt_at',d.next_attempt_at,'error_code',d.error_code)
                ORDER BY d.channel) FILTER (WHERE d.delivery_id IS NOT NULL),'[]'::jsonb) AS deliveries
         FROM notification_events e
         LEFT JOIN notification_receipts r ON r.notification_id=e.notification_id AND r.platform_user_id=$2
         LEFT JOIN notification_deliveries d ON d.notification_id=e.notification_id
        WHERE e.tenant_id=$1 AND ${statusClause}
        GROUP BY e.notification_id,r.read_at ORDER BY e.last_occurred_at DESC LIMIT $3`,
      [auth.tenant_id, auth.platform_user_id, limit],
    );
    result(response, 200, requestId, { data: notifications.rows, pagination: { limit } });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/notification-preferences") {
    result(response, 200, requestId, { data: await notificationPreference(auth.tenant_id), enterprise_wechat_mode: process.env.ENTERPRISE_WECHAT_NOTIFICATION_MODE === "dry_run" ? "dry_run" : "off" });
    return true;
  }

  if (request.method === "PUT" && url.pathname === "/api/v1/notification-preferences") {
    if (auth.role !== "tenant_admin") {
      result(response, 403, requestId, { error: { code: "admin_required", message: "仅企业管理员可以修改通知偏好" } });
      return true;
    }
    try {
      const preference = validatePreference(await jsonInput(request));
      const saved = await pool.query(
        `INSERT INTO notification_preferences
          (tenant_id,channels,minimum_external_severity,quiet_hours_start,quiet_hours_end,timezone,escalation_minutes,
           message_notification_mode,unattended_minutes,include_message_preview,updated_by)
         VALUES ($1,$2,$3,$4::time,$5::time,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tenant_id) DO UPDATE SET channels=EXCLUDED.channels,
           minimum_external_severity=EXCLUDED.minimum_external_severity,quiet_hours_start=EXCLUDED.quiet_hours_start,
           quiet_hours_end=EXCLUDED.quiet_hours_end,timezone=EXCLUDED.timezone,
           escalation_minutes=EXCLUDED.escalation_minutes,message_notification_mode=EXCLUDED.message_notification_mode,
           unattended_minutes=EXCLUDED.unattended_minutes,include_message_preview=EXCLUDED.include_message_preview,
           updated_by=EXCLUDED.updated_by,updated_at=NOW()
         RETURNING channels,minimum_external_severity,quiet_hours_start::text,quiet_hours_end::text,timezone,
                   escalation_minutes,message_notification_mode,unattended_minutes,include_message_preview,updated_at`,
        [auth.tenant_id, preference.channels, preference.minimum_external_severity, preference.quiet_hours_start,
         preference.quiet_hours_end, preference.timezone, preference.escalation_minutes,
         preference.message_notification_mode, preference.unattended_minutes, preference.include_message_preview, auth.actor_id],
      );
      await pool.query(
        `INSERT INTO audit_logs
          (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
         VALUES ($1,$2,$3,'notification.preference_updated','notification_preference',$1,$4,$5)`,
        [auth.tenant_id, auth.auth_kind, auth.actor_id, saved.rows[0], requestId],
      );
      result(response, 200, requestId, { data: saved.rows[0] });
    } catch (error) {
      const message = error instanceof Error && error.message !== "invalid_json" ? error.message : "通知偏好格式不正确";
      result(response, 400, requestId, { error: { code: "invalid_notification_preference", message } });
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/notifications/synthetic") {
    if (auth.role !== "tenant_admin" || process.env.NOTIFICATION_SYNTHETIC_ENABLED !== "true") {
      result(response, 403, requestId, { error: { code: "synthetic_disabled", message: "当前环境不允许生成合成通知" } });
      return true;
    }
    try {
      const input = await jsonInput(request);
      const severity = String(input.severity ?? "warning") as NotificationSeverity;
      const dedupeKey = String(input.dedupe_key ?? "");
      if (!['info', 'warning', 'critical'].includes(severity) || !validDedupeKey(dedupeKey)) throw new Error("合成通知参数不正确");
      const created = await emitNotification({
        tenant_id: auth.tenant_id,
        event_type: "synthetic.notification",
        severity,
        title: safeNotificationText(input.title ?? "合成通知验收", 160),
        summary: safeNotificationText(input.summary ?? "此通知仅用于 Phase 5.1 验收，不包含真实客户数据。", 500),
        dedupe_key: dedupeKey,
        metadata: { synthetic: true },
        actor_type: auth.auth_kind,
        actor_id: auth.actor_id,
        request_id: requestId,
      });
      result(response, created.duplicate ? 200 : 201, requestId, { data: created });
    } catch (error) {
      result(response, 400, requestId, { error: { code: "invalid_synthetic_notification", message: error instanceof Error ? error.message : "参数不正确" } });
    }
    return true;
  }

  const action = url.pathname.match(/^\/api\/v1\/notifications\/([0-9a-f-]{36})\/(read|acknowledge|resolve)$/i);
  if (request.method === "POST" && action) {
    const [, notificationId, operation] = action;
    if (operation === "read") {
      if (!auth.platform_user_id) {
        result(response, 409, requestId, { error: { code: "platform_identity_required", message: "需要平台成员身份" } });
        return true;
      }
      const receipt = await pool.query(
        `INSERT INTO notification_receipts (notification_id,tenant_id,platform_user_id)
         SELECT notification_id,tenant_id,$3 FROM notification_events WHERE notification_id=$1 AND tenant_id=$2
         ON CONFLICT (notification_id,platform_user_id) DO UPDATE SET read_at=NOW() RETURNING notification_id,read_at`,
        [notificationId, auth.tenant_id, auth.platform_user_id],
      );
      result(response, receipt.rows[0] ? 200 : 404, requestId, receipt.rows[0] ? { data: receipt.rows[0] } : { error: { code: "notification_not_found" } });
      return true;
    }
    if (operation === "resolve" && auth.role !== "tenant_admin") {
      result(response, 403, requestId, { error: { code: "admin_required", message: "仅企业管理员可以解决通知" } });
      return true;
    }
    const nextStatus = operation === "resolve" ? "resolved" : "acknowledged";
    const updated = await pool.query(
      `UPDATE notification_events SET status=$3,acknowledged_by=COALESCE(acknowledged_by,$4),
          acknowledged_at=COALESCE(acknowledged_at,NOW()),resolved_at=CASE WHEN $3='resolved' THEN NOW() ELSE resolved_at END,
          updated_at=NOW() WHERE notification_id=$1 AND tenant_id=$2 AND status<>'resolved'
        RETURNING notification_id,status,acknowledged_at,resolved_at`,
      [notificationId, auth.tenant_id, nextStatus, auth.platform_user_id],
    );
    if (updated.rows[0]) {
      await pool.query(
        `INSERT INTO audit_logs
          (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
         VALUES ($1,$2,$3,$4,'notification',$5,$6,$7)`,
        [auth.tenant_id, auth.auth_kind, auth.actor_id, `notification.${nextStatus}`, notificationId, updated.rows[0], requestId],
      );
    }
    result(response, updated.rows[0] ? 200 : 404, requestId, updated.rows[0] ? { data: updated.rows[0] } : { error: { code: "notification_not_found" } });
    return true;
  }

  result(response, 404, requestId, { error: { code: "not_found", message: "通知接口不存在" } });
  return true;
}
