import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "./shared.js";
import { claimTrial, getTrialOverview, TrialEligibilityError, TrialNotAvailableError } from "./trial.js";

type Auth = {
  tenant_id: string; role: "tenant_admin" | "supervisor" | "agent"; platform_user_id: string | null;
  auth_kind: "api_key" | "console_session"; actor_id: string;
};

async function inputBody(request: IncomingMessage) {
  try { return JSON.parse((await readBody(request)).toString("utf8")) as Record<string, unknown>; }
  catch { return {}; }
}

export async function handleTrialApi(request: IncomingMessage, response: ServerResponse, url: URL, auth: Auth, requestId: string) {
  if (!url.pathname.startsWith("/api/v1/growth/trial")) return false;
  if (auth.role === "agent") {
    sendJson(response, 403, { request_id: requestId, error: { code: "forbidden", message: "当前角色不能查看或管理试用" } }); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/growth/trial") {
    const campaignKey = String(url.searchParams.get("campaign_key") ?? "professional-trial-cn");
    try { sendJson(response, 200, { request_id: requestId, data: await getTrialOverview(auth.tenant_id, campaignKey) }); }
    catch (error) {
      const message = error instanceof Error ? error.message : "trial unavailable";
      sendJson(response, 400, { request_id: requestId, error: { code: "invalid_campaign", message } });
    }
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/growth/trial/claim") {
    if (auth.role !== "tenant_admin" || auth.auth_kind !== "console_session" || !auth.platform_user_id) {
      sendJson(response, 403, { request_id: requestId, error: { code: "console_admin_required", message: "仅已登录的企业管理员可以领取试用" } }); return true;
    }
    const idempotencyKey = String(request.headers["idempotency-key"] ?? "").trim();
    if (!idempotencyKey || idempotencyKey.length > 128) {
      sendJson(response, 400, { request_id: requestId, error: { code: "idempotency_key_required", message: "需要有效的 Idempotency-Key" } }); return true;
    }
    const input = await inputBody(request);
    const campaignKey = typeof input.campaign_key === "string" ? input.campaign_key : "professional-trial-cn";
    try {
      const entitlement = await claimTrial(auth.tenant_id, campaignKey, { actor_type: "platform_user", actor_id: auth.platform_user_id, request_id: requestId });
      sendJson(response, 200, { request_id: requestId, data: entitlement });
    } catch (error) {
      if (error instanceof TrialEligibilityError) {
        sendJson(response, error.outcome === "review" ? 202 : 409, { request_id: requestId, error: { code: `trial_${error.outcome}`, reason_codes: error.reason_codes } });
      } else if (error instanceof TrialNotAvailableError) {
        sendJson(response, 404, { request_id: requestId, error: { code: "trial_not_available" } });
      } else throw error;
    }
    return true;
  }
  sendJson(response, 404, { request_id: requestId, error: { code: "not_found", message: "试用接口不存在" } });
  return true;
}
