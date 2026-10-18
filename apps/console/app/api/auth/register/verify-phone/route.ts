import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, REGISTRATION_COOKIE } from "../../../../../lib/console-session";

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = request.cookies.get(REGISTRATION_COOKIE)?.value;
  const code = String((await request.formData()).get("code") ?? "");
  if (!token) return NextResponse.redirect(consoleUrl("/register?error=registration_expired"), 303);
  try {
    const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/auth/registration/verify-phone"), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ code }), cache: "no-store", signal: AbortSignal.timeout(8_000) });
    const payload = await upstream.json() as { error?: { code?: string } };
    return NextResponse.redirect(consoleUrl(`/register?${upstream.ok ? "phone=verified" : `error=${payload.error?.code ?? "unavailable"}`}`), 303);
  } catch { return NextResponse.redirect(consoleUrl("/register?error=unavailable"), 303); }
}
