import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, sessionToken } from "../../../../../lib/console-session";

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/channels/wechat-official-account/synthetic-validate"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  return NextResponse.redirect(consoleUrl(upstream.ok ? "/channels?status=validated" : `/channels?error=${upstream.status}`), 303);
}
