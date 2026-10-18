import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, sessionToken } from "../../../../../lib/console-session";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  const { id } = await params;
  const form = await request.formData();
  const cancelKey = String(form.get("cancel_key") ?? "").trim();
  const cancelValue = String(form.get("cancel_value") ?? "");
  const local = String(form.get("scheduled_at") ?? "").trim();
  const parsed = local ? new Date(`${local}:00+08:00`) : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) return NextResponse.redirect(consoleUrl("/operations/outbound?result=campaign-failed"), 303);
  const scheduledAt = parsed.toISOString();
  const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/message-campaigns/${encodeURIComponent(id)}/schedule`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      scheduled_at: scheduledAt,
      timezone: "Asia/Shanghai",
      quiet_hours_start: String(form.get("quiet_hours_start") ?? "22:00"),
      quiet_hours_end: String(form.get("quiet_hours_end") ?? "08:00"),
      rate_limit_per_minute: Number(form.get("rate_limit_per_minute") ?? 20),
      cancel_condition: cancelKey ? { type: "customer_attribute_equals", key: cancelKey, value: cancelValue } : { type: "none" },
      reason: String(form.get("reason") ?? "")
    }), cache: "no-store"
  });
  return NextResponse.redirect(consoleUrl(`/operations/outbound?result=${upstream.ok ? "campaign-scheduled" : upstream.status === 409 ? "disabled" : "campaign-failed"}`), 303);
}
