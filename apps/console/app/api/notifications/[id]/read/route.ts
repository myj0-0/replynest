import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, sessionToken } from "../../../../../lib/console-session";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.redirect(consoleUrl("/notifications?result=invalid"), 303);
  const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/notifications/${id}/read`), { method: "POST", headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  return NextResponse.redirect(consoleUrl(`/notifications?result=${upstream.ok ? "read" : "failed"}`), 303);
}
