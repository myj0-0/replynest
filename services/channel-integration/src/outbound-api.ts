import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "./database.js";
import { sendJson } from "./shared.js";

type OutboundAuth = {
  tenant_id: string;
  role: "tenant_admin" | "supervisor" | "agent";
  actor_id: string;
  auth_kind: "api_key" | "console_session";
};

function result(response: ServerResponse, status: number, requestId: string, body: Record<string, unknown>) {
  sendJson(response, status, { request_id: requestId, ...body });
}

export async function handleOutboundApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  auth: OutboundAuth,
  requestId: string
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/api/v1/outbound-deliveries") {
    const requestedStatus = url.searchParams.get("status") ?? "failed";
    const status = ["failed", "processing", "retry_pending", "delivered"].includes(requestedStatus) ? requestedStatus : "failed";
    const requestedLimit = Number(url.searchParams.get("limit") ?? 20);
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 20;
    const deliveries = await pool.query(
      `SELECT id,chatwoot_message_id,chatwoot_conversation_id,status,failure_code,retryable,
              attempt_count,next_retry_at,last_attempt_at,failure_notified_at,created_at,delivered_at,updated_at,
              LEFT(COALESCE(payload->>'content',''),200) AS message_preview
         FROM outbound_deliveries
        WHERE tenant_id=$1 AND status=$2
        ORDER BY updated_at DESC,id DESC LIMIT $3`,
      [auth.tenant_id, status, limit]
    );
    result(response, 200, requestId, { data: deliveries.rows });
    return true;
  }

  const retryMatch = url.pathname.match(/^\/api\/v1\/outbound-deliveries\/(\d+)\/retry$/);
  if (request.method === "POST" && retryMatch) {
    if (auth.role === "agent") {
      result(response, 403, requestId, { error: { code: "insufficient_role", message: "仅管理员或主管可以人工重试" } });
      return true;
    }
    if (process.env.WECHAT_LIVE_ENABLED !== "true") {
      result(response, 409, requestId, { error: { code: "live_send_disabled", message: "真实发送开关未开启，不能执行人工重试" } });
      return true;
    }
    const delivery = await pool.query(
      `UPDATE outbound_deliveries SET status='retry_pending', retryable=TRUE, next_retry_at=NOW(),
          failure_notified_at=NULL, updated_at=NOW()
        WHERE id=$1 AND tenant_id=$2 AND status='failed'
        RETURNING id,chatwoot_message_id,status,attempt_count,next_retry_at`,
      [retryMatch[1], auth.tenant_id]
    );
    if (!delivery.rows[0]) {
      result(response, 404, requestId, { error: { code: "failed_delivery_not_found", message: "未找到可重试的失败消息" } });
      return true;
    }
    await pool.query(
      `INSERT INTO audit_logs
        (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
       VALUES ($1,$2,$3,'outbound_delivery.retry_requested','outbound_delivery',$4,$5,$6)`,
      [auth.tenant_id, auth.auth_kind, auth.actor_id, String(delivery.rows[0].id), delivery.rows[0], requestId]
    );
    result(response, 202, requestId, { data: delivery.rows[0] });
    return true;
  }
  return false;
}
