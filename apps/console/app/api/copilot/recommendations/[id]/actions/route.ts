import {activityGatewayFetch} from "../../../../../../lib/activity-gateway-fetch";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { gatewayUrl, hasValidOrigin, sessionToken } from "../../../../../../lib/console-session";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: { code: "invalid_origin", message: "请求来源不合法" } }, { status: 403 });
  const supplied = request.headers.get("authorization") ?? "";
  const token = /^Bearer [a-f0-9]{64}$/i.test(supplied) ? supplied.slice(7) : await sessionToken();
  if (!token) return NextResponse.json({ error: { code: "session_expired", message: "登录已失效" } }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: { code: "invalid_recommendation_id", message: "推荐标识不合法" } }, { status: 400 });
  const input = await request.json();
  const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/ai/recommendations/${id}/actions`), {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": `copilot-action-${randomUUID()}` },
    body: JSON.stringify(input), cache: "no-store"
  });
  return NextResponse.json(await upstream.json(), { status: upstream.status });
}
