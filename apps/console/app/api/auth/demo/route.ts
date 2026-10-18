import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { CONSOLE_SESSION_COOKIE, consoleUrl, cookieOptions, gatewayUrl, hasValidOrigin } from "../../../../lib/console-session";

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const publicHostname = process.env.CONSOLE_PUBLIC_ORIGIN ? new URL(process.env.CONSOLE_PUBLIC_ORIGIN).hostname : "";
  if (process.env.CONSOLE_DEMO_LOGIN !== "true" || !["localhost", "127.0.0.1", "::1"].includes(publicHostname)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const apiKey = process.env.DEMO_TENANT_API_KEY;
  if (!apiKey) return NextResponse.redirect(consoleUrl("/login?error=unavailable"), 303);
  try {
    const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/auth/demo-session"), { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, cache: "no-store", signal: AbortSignal.timeout(5_000) });
    const body = await upstream.json() as { data?: { token?: string; expires_in?: number } };
    if (!upstream.ok || !body.data?.token || !body.data.expires_in) throw new Error("demo session unavailable");
    const response = NextResponse.redirect(consoleUrl("/"), 303);
    response.cookies.set(CONSOLE_SESSION_COOKIE, body.data.token, cookieOptions(body.data.expires_in));
    return response;
  } catch {
    return NextResponse.redirect(consoleUrl("/login?error=unavailable"), 303);
  }
}
