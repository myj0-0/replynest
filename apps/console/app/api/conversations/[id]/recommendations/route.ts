import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { gatewayUrl, hasValidOrigin, sessionToken } from "../../../../../lib/console-session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!hasValidOrigin(request)) return json({ error: { code: "invalid_origin", message: "请求来源不合法" } }, 403);
  const token = await sessionToken();
  if (!token) return json({ error: { code: "session_expired", message: "登录已失效" } }, 401);
  const { id } = await context.params;
  if (!UUID.test(id)) return json({ error: { code: "conversation_not_found", message: "会话不存在" } }, 404);

  let input: unknown;
  try { input = await request.json(); } catch { return json({ error: { code: "invalid_request", message: "请求格式不正确" } }, 400); }
  const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
  const question = typeof record?.question === "string" ? record.question.trim() : "";
  const orderId = typeof record?.order_id === "string" ? record.order_id.trim() : "";
  if (!record || Object.keys(record).some(key => !["question", "order_id"].includes(key)) || !question || question.length > 4_000 || orderId.length > 100) {
    return json({ error: { code: "invalid_request", message: "客户问题不能为空且不能超过 4000 字，订单号不能超过 100 字" } }, 400);
  }

  try {
    const detailResponse = await activityGatewayFetch(gatewayUrl(`/api/v1/conversations/${encodeURIComponent(id)}`), {
      headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(10_000)
    });
    const detail = await detailResponse.json() as { data?: { contact?: { id?: string; channel?: string } | null }; error?: unknown };
    if (!detailResponse.ok || !detail.data) return json(detail, detailResponse.status);
    const customerId = detail.data.contact?.id ?? "";
    if (!UUID.test(customerId)) return json({ error: { code: "customer_not_mapped", message: "当前会话尚未建立可用客户映射" } }, 409);

    const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/ai/recommendations"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": `workbench-copilot-${randomUUID()}`
      },
      body: JSON.stringify({
        customer_id: customerId,
        conversation_id: id,
        question,
        context: { channel: detail.data.contact?.channel ?? "unknown", ...(orderId ? { order_id: orderId } : {}) }
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000)
    });
    let body: unknown;
    try { body = await upstream.json(); } catch { return json({ error: { code: "recommendation_unavailable", message: "AI 建议服务暂时不可用" } }, 503); }
    return json(body, upstream.status);
  } catch {
    return json({ error: { code: "recommendation_unavailable", message: "AI 建议服务暂时不可用" } }, 503);
  }
}
