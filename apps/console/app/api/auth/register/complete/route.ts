import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { CONSOLE_SESSION_COOKIE, consoleUrl, cookieOptions, gatewayUrl, hasValidOrigin, REGISTRATION_COOKIE } from "../../../../../lib/console-session";

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = request.cookies.get(REGISTRATION_COOKIE)?.value;
  if (!token) return NextResponse.redirect(consoleUrl("/register?error=registration_expired"), 303);
  try {
    const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/auth/registration/complete"), { method: "POST", headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    const payload = await upstream.json() as { data?: { session?: { token?: string; expires_in?: number } }; error?: { code?: string } };
    if (!upstream.ok || !payload.data?.session?.token || !payload.data.session.expires_in) return NextResponse.redirect(consoleUrl(`/register?error=${payload.error?.code ?? "unavailable"}`), 303);
    const response = NextResponse.redirect(consoleUrl("/"), 303);
    response.cookies.set(CONSOLE_SESSION_COOKIE, payload.data.session.token, cookieOptions(payload.data.session.expires_in));
    response.cookies.delete(REGISTRATION_COOKIE);
    return response;
  } catch { return NextResponse.redirect(consoleUrl("/register?error=unavailable"), 303); }
}
