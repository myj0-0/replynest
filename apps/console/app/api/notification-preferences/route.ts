import {activityGatewayFetch} from "../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, sessionToken } from "../../../lib/console-session";

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  const form = await request.formData();
  const channels = ["in_app", ...form.getAll("channels").map(String)];
  const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/notification-preferences"), {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      channels,
      minimum_external_severity: String(form.get("minimum_external_severity") ?? "warning"),
      quiet_hours_start: String(form.get("quiet_hours_start") ?? "22:00"),
      quiet_hours_end: String(form.get("quiet_hours_end") ?? "08:00"),
      timezone: String(form.get("timezone") ?? "Asia/Shanghai"),
      escalation_minutes: Number(form.get("escalation_minutes") ?? 15),
      message_notification_mode: String(form.get("message_notification_mode") ?? "unattended"),
      unattended_minutes: Number(form.get("unattended_minutes") ?? 10),
      include_message_preview: form.get("include_message_preview") === "on",
    }),
    cache: "no-store",
  });
  const result = upstream.ok ? "saved" : "failed";
  return NextResponse.redirect(consoleUrl(`/notifications?result=${result}`), 303);
}
