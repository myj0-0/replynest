import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, sessionToken } from "../../../../../lib/console-session";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.redirect(consoleUrl("/channels?social_result=failed"), 303);
  const form = await request.formData();
  const keywords = String(form.get("keywords") ?? "").split(/[，,\n]/).map(value => value.trim()).filter(Boolean);
  const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/social/rules/${id}`), {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: String(form.get("name") ?? ""),
      priority: Number(form.get("priority") ?? 100),
      category: String(form.get("category") ?? "after_sales"),
      keywords,
      status: String(form.get("status") ?? "disabled"),
      expected_version: Number(form.get("expected_version") ?? 0),
    }),
    cache: "no-store",
  });
  return NextResponse.redirect(consoleUrl(`/channels?social_result=${upstream.ok ? "rule_updated" : "failed"}`), 303);
}
