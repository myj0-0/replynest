import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { gatewayUrl, hasValidOrigin, sessionToken } from "../../../../lib/console-session";

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: { code: "invalid_origin", message: "请求来源不合法" } }, { status: 403 });
  const supplied = request.headers.get("authorization") ?? "";
  const token = /^Bearer [a-f0-9]{64}$/i.test(supplied) ? supplied.slice(7) : await sessionToken();
  if (!token) return NextResponse.json({ error: { code: "session_expired", message: "登录已失效" } }, { status: 401 });
  const input = await request.json() as Record<string, unknown>;
  const contextResponse = await activityGatewayFetch(gatewayUrl("/api/v1/copilot/context"), {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ conversation_id: input.conversation_id, account_id: input.account_id, current_agent_email: input.current_agent_email }), cache: "no-store"
  });
  const contextBody = await contextResponse.json() as { data?: { customer_id: string; conversation_id: string; channel: string }; error?: unknown };
  if (!contextResponse.ok || !contextBody.data) return NextResponse.json(contextBody, { status: contextResponse.status });
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (!question || question.length > 4000) return NextResponse.json({ error: { code: "invalid_question", message: "客户问题不能为空且不能超过4000字" } }, { status: 400 });
  const orderId = typeof input.order_id === "string" ? input.order_id.trim() : "";
  const recommendationResponse = await activityGatewayFetch(gatewayUrl("/api/v1/ai/recommendations"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": `copilot-${randomUUID()}` },
    body: JSON.stringify({ customer_id: contextBody.data.customer_id, conversation_id: contextBody.data.conversation_id, question, context: { channel: contextBody.data.channel, ...(orderId ? { order_id: orderId } : {}) } }), cache: "no-store"
  });
  return NextResponse.json(await recommendationResponse.json(), { status: recommendationResponse.status });
}
