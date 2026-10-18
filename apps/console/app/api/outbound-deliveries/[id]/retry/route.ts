import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, sessionToken } from "../../../../../lib/console-session";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  const { id } = await params;
  if (!/^\d+$/.test(id)) return NextResponse.redirect(consoleUrl("/operations/outbound?result=invalid"), 303);
  const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/outbound-deliveries/${id}/retry`), {
    method: "POST", headers: { authorization: `Bearer ${token}` }, cache: "no-store"
  });
  const result = upstream.status === 202 ? "queued" : upstream.status === 409 ? "disabled" : "failed";
  return NextResponse.redirect(consoleUrl(`/operations/outbound?result=${result}`), 303);
}
