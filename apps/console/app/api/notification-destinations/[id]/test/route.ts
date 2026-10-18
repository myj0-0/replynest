import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, sessionToken } from "../../../../../lib/console-session";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.redirect(consoleUrl("/notifications?result=invalid"), 303);
  try {
  const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/notification-destinations/${id}/test`), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  return NextResponse.redirect(consoleUrl(`/notifications?result=${upstream.status===202 ? "test-queued" : upstream.ok ? "test-delivered" : "test-failed"}`), 303);
  } catch {
    return NextResponse.redirect(consoleUrl('/notifications?result=test-unconfirmed'),303);
  }
}
