import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, sessionToken } from "../../../../lib/console-session";

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  const form = await request.formData();
  const keywords = String(form.get("keywords") ?? "").split(/[，,\n]/).map(value => value.trim()).filter(Boolean);
  const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/social/rules"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: String(form.get("name") ?? ""),
      priority: Number(form.get("priority") ?? 100),
      category: String(form.get("category") ?? "after_sales"),
      keywords,
      status: "active",
    }),
    cache: "no-store",
  });
  return NextResponse.redirect(consoleUrl(`/channels?social_result=${upstream.ok ? "rule_created" : "failed"}`), 303);
}
