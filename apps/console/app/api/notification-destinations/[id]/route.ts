import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, sessionToken } from "../../../../lib/console-session";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.redirect(consoleUrl("/notifications?result=invalid"), 303);
  const form = await request.formData();
  const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/notification-destinations/${id}`), {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      display_name: String(form.get("display_name") ?? ""),
      status: String(form.get("status") ?? "disabled"),
    }),
    cache: "no-store",
  });
  return NextResponse.redirect(consoleUrl(`/notifications?result=${upstream.ok ? "destination-updated" : "destination-failed"}`), 303);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: { code: "invalid_origin" } }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.json({ error: { code: "session_expired" } }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: { code: "destination_not_found" } }, { status: 404 });
  const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/notification-destinations/${id}`), {
    method: "DELETE", headers: { authorization: `Bearer ${token}` }, cache: "no-store",
  });
  let body: unknown;
  try { body = await upstream.json(); } catch { body = { error: { code: "invalid_upstream_response" } }; }
  return NextResponse.json(body, { status: upstream.status, headers: { "cache-control": "private, no-store" } });
}
