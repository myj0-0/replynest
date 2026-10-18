import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { gatewayUrl, hasValidOrigin, sessionToken } from "../../../../lib/console-session";
async function proxy(request: NextRequest) {
  if (request.method === "POST" && !hasValidOrigin(request)) return NextResponse.json({ error: { code: "invalid_origin" } }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.json({}, { status: 401 });
  try {
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body && body.length > 4000) return NextResponse.json({}, { status: 413 });
    const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/channels/web-chat"), { method: request.method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body, cache: "no-store", signal: AbortSignal.timeout(45000) });
    return NextResponse.json(await upstream.json(), { status: upstream.status, headers: { "cache-control": "private, no-store" } });
  } catch { return NextResponse.json({ error: { code: "web_chat_setup_unconfirmed" } }, { status: 503 }); }
}
export const GET = proxy;
export const POST = proxy;
