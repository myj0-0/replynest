import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { completeRegistration, registrationStatus, RegistrationConflictError, RegistrationGoneError, RegistrationInputError, startRegistration, verifyRegistrationEmail, verifyRegistrationPhone } from "./registration.js";
import { RegistrationAccessError, RegistrationRateLimitError } from "./registration-security.js";
import { registrationControlState, registrationEffectiveEnabled } from "./registration-operations.js";
import { readBody, sendJson } from "./shared.js";
import { verifyCaptchaToken } from "./captcha.js";

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  try { return JSON.parse((await readBody(request)).toString("utf8")) as Record<string, unknown>; }
  catch { throw new RegistrationInputError("invalid_request"); }
}
function bearer(request: IncomingMessage) {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}
function fail(response: ServerResponse, error: unknown) {
  if (error instanceof RegistrationAccessError) return sendJson(response, 403, { error: { code: error.code } });
  if (error instanceof RegistrationRateLimitError) {
    response.setHeader("retry-after", String(error.retry_after_seconds));
    return sendJson(response, 429, { error: { code: error.code, retry_after_seconds: error.retry_after_seconds } });
  }
  if (error instanceof RegistrationInputError) return sendJson(response, 400, { error: { code: error.code } });
  if (error instanceof RegistrationConflictError) return sendJson(response, 409, { error: { code: error.code } });
  if (error instanceof RegistrationGoneError) return sendJson(response, 410, { error: { code: error.code } });
  console.warn("Self-service registration failed", error instanceof Error ? error.message : String(error));
  return sendJson(response, 503, { error: { code: "registration_temporarily_unavailable" } });
}

export async function handleRegistrationApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/v1/auth/registration")) return false;
  if (request.method === "GET" && url.pathname === "/api/v1/auth/registration/config") {
    const state = await registrationControlState();
    sendJson(response, 200, { data: { enabled: state.effective_enabled, access_mode: state.access_mode, invite_required: state.access_mode === "invite_only", email_required: true, mainland_phone_required: true, legal_ready: state.legal.publish_ready, terms_version: state.legal.terms_version, privacy_version: state.legal.privacy_version } });
    return true;
  }
  try {
    if (request.method === "POST" && url.pathname === "/api/v1/auth/registration/start") {
      if (!(await registrationEffectiveEnabled())) { sendJson(response, 403, { error: { code: "self_service_registration_disabled" } }); return true; }
      const input = await body(request);
      if (!(await verifyCaptchaToken(input.captcha_token))) { sendJson(response, 403, { error: { code: "captcha_required" } }); return true; }
      const idempotencyKey = String(request.headers["idempotency-key"] ?? "");
      const result = await startRegistration({
        email: String(input.email ?? ""), display_name: String(input.display_name ?? ""), company_name: String(input.company_name ?? ""),
        phone: String(input.phone ?? ""), password: String(input.password ?? ""), referral_code: typeof input.referral_code === "string" ? input.referral_code : undefined,
        legal_accepted: input.legal_accepted === true, terms_version: String(input.terms_version ?? ""), privacy_version: String(input.privacy_version ?? ""),
        idempotency_key: idempotencyKey, resume_token: typeof input.registration_token === "string" ? input.registration_token : randomBytes(32).toString("hex"),
      }, randomUUID(), undefined, { risk_context: {
        ip: String(request.headers["x-replynest-client-ip"] ?? request.socket.remoteAddress ?? ""),
        device_id: String(request.headers["x-replynest-registration-device"] ?? ""),
      } });
      sendJson(response, result.idempotent_replay ? 200 : 201, { data: result }); return true;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/auth/registration/verify-email") {
      const input = await body(request); sendJson(response, 200, { data: await verifyRegistrationEmail(String(input.token ?? "")) }); return true;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/auth/registration/verify-phone") {
      const input = await body(request); sendJson(response, 200, { data: await verifyRegistrationPhone(bearer(request), String(input.code ?? "")) }); return true;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/auth/registration/status") {
      sendJson(response, 200, { data: await registrationStatus(bearer(request)) }); return true;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/auth/registration/complete") {
      sendJson(response, 200, { data: await completeRegistration(bearer(request)) }); return true;
    }
    sendJson(response, 404, { error: { code: "not_found" } }); return true;
  } catch (error) { fail(response, error); return true; }
}
