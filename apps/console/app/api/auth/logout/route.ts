import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { CONSOLE_SESSION_COOKIE, consoleUrl, cookieOptions, gatewayUrl, hasValidOrigin, sessionToken } from "../../../../lib/console-session";

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (token) {
    try { await activityGatewayFetch(gatewayUrl("/api/v1/auth/logout"), { method: "POST", headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(5_000) }); } catch { /* local cookie still expires */ }
  }
  const response = NextResponse.redirect(consoleUrl("/login"), 303);
  response.cookies.set(CONSOLE_SESSION_COOKIE, "", cookieOptions(0));
  return response;
}
