import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "./database.js";
import { sendJson } from "./shared.js";

type InboundAuth = {
  tenant_id: string;
  role: "tenant_admin" | "supervisor" | "agent";
  actor_id: string;
  auth_kind: "api_key" | "console_session";
};

function result(response: ServerResponse, status: number, requestId: string, body: Record<string, unknown>) {
  sendJson(response, status, { request_id: requestId, ...body });
}

export async function handleInboundApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  auth: InboundAuth,
  requestId: string
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/api/v1/inbound-events") {
    if (auth.role === "agent") {
      result(response, 403, requestId, { error: { code: "insufficient_role", message: "仅管理员或主管可以查看入站队列" } });
      return true;
    }
    const requestedStatus = url.searchParams.get("status") ?? "dead";
    const status = ["queued", "processing", "retry_pending", "processed", "dead"].includes(requestedStatus) ? requestedStatus : "dead";
    const requestedLimit = Number(url.searchParams.get("limit") ?? 20);
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 20;
    const events = await pool.query(
      `SELECT id,channel,external_event_id,external_message_id,status,failure_code,attempt_count,max_attempts,
              next_attempt_at,last_attempt_at,dead_at,replay_count,created_at,updated_at,processed_at
         FROM gateway_events WHERE tenant_id=$1 AND status=$2
        ORDER BY updated_at DESC,id DESC LIMIT $3`,
      [auth.tenant_id, status, limit]
    );
    result(response, 200, requestId, { data: events.rows, pagination: { limit } });
    return true;
  }

  const replayMatch = url.pathname.match(/^\/api\/v1\/inbound-events\/(\d+)\/replay$/);
  if (request.method === "POST" && replayMatch) {
    if (auth.role !== "tenant_admin") {
      result(response, 403, requestId, { error: { code: "insufficient_role", message: "仅企业管理员可以重放死信" } });
      return true;
    }
    const replayed = await pool.query(
      `UPDATE gateway_events SET status='queued',attempt_count=0,next_attempt_at=NOW(),error=NULL,failure_code=NULL,
         dead_at=NULL,locked_at=NULL,worker_id=NULL,replay_count=replay_count+1,updated_at=NOW()
       WHERE id=$1 AND tenant_id=$2 AND status='dead'
       RETURNING id,channel,external_event_id,external_message_id,status,replay_count,updated_at`,
      [replayMatch[1], auth.tenant_id]
    );
    if (!replayed.rows[0]) {
      result(response, 404, requestId, { error: { code: "dead_letter_not_found", message: "未找到可重放的死信消息" } });
      return true;
    }
    await pool.query(
      `INSERT INTO audit_logs
        (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
       VALUES ($1,$2,$3,'inbound_event.replay_requested','gateway_event',$4,$5,$6)`,
      [auth.tenant_id, auth.auth_kind, auth.actor_id, replayMatch[1], replayed.rows[0], requestId]
    );
    result(response, 202, requestId, { data: replayed.rows[0] });
    return true;
  }
  return false;
}
