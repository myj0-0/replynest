import {activityGatewayFetch} from "../../../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, sessionToken } from "../../../../../../lib/console-session";

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  const form = await request.formData();
  const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/social/demo/tiktok/events"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ event_type: String(form.get("event_type") ?? ""), content: String(form.get("content") ?? "") }),
    cache: "no-store",
  });
  if (upstream.status === 401) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  return NextResponse.redirect(consoleUrl(`/channels/tiktok-demo?result=${upstream.ok ? "event_created" : "failed"}`), 303);
}
