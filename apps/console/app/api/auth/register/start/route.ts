import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, cookieOptions, gatewayUrl, hasValidOrigin, REGISTRATION_COOKIE } from "../../../../../lib/console-session";
import {mainlandRegistrationPhone} from '../../../../../lib/mainland-registration-phone';

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const form = await request.formData();
  const phone=mainlandRegistrationPhone(form.get('phone'));
  if(!phone)return NextResponse.redirect(consoleUrl('/register?error=invalid_registration_input'),303);
  const registrationToken = randomBytes(32).toString("hex");
  const existingDevice = request.cookies.get("rn_registration_device")?.value;
  const registrationDevice = existingDevice && /^[A-Za-z0-9_-]{32,128}$/.test(existingDevice) ? existingDevice : randomBytes(24).toString("base64url");
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  const clientIp = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ?? forwardedFor ?? "";
  const redirectWithDevice = (url: string) => {
    const response = NextResponse.redirect(consoleUrl(url), 303);
    response.cookies.set("rn_registration_device", registrationDevice, cookieOptions(30 * 24 * 60 * 60));
    return response;
  };
  try {
    const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/auth/registration/start"), {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomUUID(), "x-replynest-registration-device": registrationDevice, ...(clientIp ? { "x-replynest-client-ip": clientIp } : {}) }, cache: "no-store", signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({ email: form.get("email"), display_name: form.get("display_name"), company_name: form.get("company_name"), phone, password: form.get("password"), referral_code: form.get("referral_code"), captcha_token: form.get("cap-token"), registration_token: registrationToken, legal_accepted: form.get("legal_accepted") === "accepted", terms_version: form.get("terms_version"), privacy_version: form.get("privacy_version") }),
    });
    const payload = await upstream.json() as { error?: { code?: string } };
    if (!upstream.ok) return redirectWithDevice(`/register?error=${payload.error?.code ?? "unavailable"}`);
    const response = redirectWithDevice("/register?started=1");
    response.cookies.set(REGISTRATION_COOKIE, registrationToken, cookieOptions(1800));
    return response;
  } catch { return redirectWithDevice("/register?error=unavailable"); }
}
