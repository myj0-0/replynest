import type { IncomingMessage, ServerResponse } from "node:http";
import { createOrGetInviteCode, referralOverview, ReferralEligibilityError, ReferralNotFoundError } from "./referral.js";
import { sendJson } from "./shared.js";

type Auth = { tenant_id: string; role: "tenant_admin" | "supervisor" | "agent"; platform_user_id: string | null; auth_kind: "api_key" | "console_session"; actor_id: string };

export async function handleReferralApi(request: IncomingMessage, response: ServerResponse, url: URL, auth: Auth, requestId: string) {
  if (!url.pathname.startsWith("/api/v1/growth/referrals")) return false;
  if (auth.role === "agent") { sendJson(response, 403, { request_id: requestId, error: { code: "forbidden", message: "当前角色不能查看邀请计划" } }); return true; }
  if (request.method === "GET" && url.pathname === "/api/v1/growth/referrals") {
    sendJson(response, 200, { request_id: requestId, data: await referralOverview(auth.tenant_id, url.searchParams.get('view') !== 'summary') }); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/growth/referrals/invite-code") {
    if (auth.role !== "tenant_admin" || auth.auth_kind !== "console_session" || !auth.platform_user_id) {
      sendJson(response, 403, { request_id: requestId, error: { code: "console_admin_required", message: "仅已登录的企业管理员可以创建邀请码" } }); return true;
    }
    const idempotencyKey = String(request.headers["idempotency-key"] ?? "").trim();
    if (!idempotencyKey || idempotencyKey.length > 128) { sendJson(response, 400, { request_id: requestId, error: { code: "idempotency_key_required" } }); return true; }
    try {
      const code = await createOrGetInviteCode(auth.tenant_id, auth.platform_user_id, { actor_type: "platform_user", actor_id: auth.platform_user_id, request_id: requestId });
      sendJson(response, 200, { request_id: requestId, data: code });
    } catch (error) {
      if (error instanceof ReferralEligibilityError) sendJson(response, 409, { request_id: requestId, error: { code: "inviter_not_eligible", reason_codes: error.reason_codes } });
      else if (error instanceof ReferralNotFoundError) sendJson(response, 404, { request_id: requestId, error: { code: "referral_campaign_unavailable" } });
      else throw error;
    }
    return true;
  }
  sendJson(response, 404, { request_id: requestId, error: { code: "not_found" } }); return true;
}
