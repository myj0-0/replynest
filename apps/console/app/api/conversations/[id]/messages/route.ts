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
  try { input = await request.json(); } catch { return json({ error: { code: "invalid_message", message: "回复内容格式不正确" } }, 400); }
  const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
  const content = typeof record?.content === "string" ? record.content.trim() : "";
  if (!record || Object.keys(record).some(key => !["content", "private"].includes(key)) || (record.private !== undefined && typeof record.private !== "boolean") || content.length < 1 || content.length > 10_000) {
    return json({ error: { code: "invalid_message", message: "回复内容必须为 1–10000 个字符" } }, 400);
  }

  try {
    const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/conversations/${encodeURIComponent(id)}/messages`), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey
      },
      body: JSON.stringify({ content, private: record.private === true }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000)
    });
    let body: unknown;
    try { body = await upstream.json(); } catch {
      return json({ error: { code: "send_outcome_uncertain", message: "发送结果尚未确认，请勿重复发送并联系管理员核查" } }, 503);
    }
    return json(body, upstream.status);
  } catch {
    // The proxy cannot prove whether the Gateway or Chatwoot accepted the write.
    // Fail closed and keep the browser from retrying with a fresh key.
    return json({ error: { code: "send_outcome_uncertain", message: "发送结果尚未确认，请勿重复发送并联系管理员核查" } }, 503);
  }
}
