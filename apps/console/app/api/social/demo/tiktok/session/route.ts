import {activityGatewayFetch} from "../../../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, sessionToken } from "../../../../../../lib/console-session";

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/social/demo/tiktok/session"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (upstream.status === 401) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  return NextResponse.redirect(consoleUrl(`/channels/tiktok-demo?result=${upstream.ok ? "initialized" : "failed"}`), 303);
}
