import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { gatewayUrl, hasValidOrigin, sessionToken } from "../../../../../lib/console-session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body: unknown, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" }
  });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!hasValidOrigin(request)) return json({ error: { code: "invalid_origin", message: "请求来源不合法" } }, 403);
  const token = await sessionToken();
  if (!token) return json({ error: { code: "session_expired", message: "登录已失效" } }, 401);
  const { id } = await context.params;
  if (!UUID.test(id)) return json({ error: { code: "conversation_not_found", message: "会话不存在" } }, 404);
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return json({ error: { code: "idempotency_key_required", message: "需要有效的幂等键" } }, 400);
  }
  let input: unknown;
  try { input = await request.json(); } catch { return json({ error: { code: "invalid_conversation_action", message: "操作格式不正确" } }, 400); }
  const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
  const claimKeys = new Set(["action", "expected_assignee_id"]);
  const assignKeys = new Set(["action", "assignee_id", "expected_assignee_id"]);
  const statusKeys = new Set(["action", "status", "expected_status"]);
  const validClaim = record?.action === "claim" && (record.expected_assignee_id === null || UUID.test(String(record.expected_assignee_id))) &&
    Object.keys(record).every(key => claimKeys.has(key));
  const validAssign = record?.action === "assign" && UUID.test(String(record.assignee_id)) &&
    (record.expected_assignee_id === null || UUID.test(String(record.expected_assignee_id))) && Object.keys(record).every(key => assignKeys.has(key));
  const validStatus = record?.action === "set_status" && ["open", "pending", "resolved"].includes(String(record.status)) &&
    ["open", "pending", "resolved", "snoozed"].includes(String(record.expected_status)) && Object.keys(record).every(key => statusKeys.has(key));
  if (!record || (!validClaim && !validAssign && !validStatus)) return json({ error: { code: "invalid_conversation_action", message: "操作参数不合法" } }, 400);
  try {
    const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/conversations/${encodeURIComponent(id)}/actions`), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(record), cache: "no-store", signal: AbortSignal.timeout(15_000)
    });
    let body: unknown;
    try { body = await upstream.json(); } catch {
      return json({ error: { code: "action_outcome_uncertain", message: "操作结果尚未确认，请刷新会话状态" } }, 503);
    }
    return json(body, upstream.status);
  } catch {
    return json({ error: { code: "action_outcome_uncertain", message: "操作结果尚未确认，请刷新会话状态" } }, 503);
  }
}
