import {activityGatewayFetch} from "../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, sessionToken } from "../../../lib/console-session";

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  const form = await request.formData();
  const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/notification-destinations"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      provider: String(form.get("provider") ?? ""),
      display_name: String(form.get("display_name") ?? ""),
      endpoint: String(form.get("endpoint") ?? ""),
      signing_secret: String(form.get("signing_secret") ?? ""),
    }),
    cache: "no-store",
  });
  return NextResponse.redirect(consoleUrl(`/notifications?result=${upstream.ok ? "destination-created" : "destination-failed"}`), 303);
}
