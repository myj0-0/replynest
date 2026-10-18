import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, sessionToken } from "../../../../../lib/console-session";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  const { id } = await params;
  const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/message-campaigns/${encodeURIComponent(id)}/snapshot`), { method: "POST", headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  return NextResponse.redirect(consoleUrl(`/operations/outbound?result=${upstream.ok ? "audience-frozen" : "campaign-failed"}`), 303);
}
