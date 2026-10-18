import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { CONSOLE_SESSION_COOKIE, consoleUrl, cookieOptions, gatewayUrl, hasValidOrigin } from "../../../../lib/console-session";

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  try {
    const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/auth/login"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, captcha_token: form.get("cap-token") }), cache: "no-store", signal: AbortSignal.timeout(7_000) });
    const body = await upstream.json() as { data?: { token?: string; expires_in?: number; workspace_required?: boolean }; error?: { code?: string } };
    if (!upstream.ok || !body.data?.token || !body.data.expires_in) return NextResponse.redirect(consoleUrl(`/login?error=${body.error?.code ?? "unavailable"}`), 303);
    const destination = body.data.workspace_required ? "/workspaces" : "/";
    const response = NextResponse.redirect(consoleUrl(destination), 303);
    response.cookies.set(CONSOLE_SESSION_COOKIE, body.data.token, cookieOptions(body.data.expires_in));
    return response;
  } catch {
    return NextResponse.redirect(consoleUrl("/login?error=unavailable"), 303);
  }
}
