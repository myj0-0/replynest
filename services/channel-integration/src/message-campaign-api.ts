import type { IncomingMessage, ServerResponse } from "node:http";
import {reviewMassCampaignBatch} from './message-campaigns.js';
import { readBody, sendJson } from "./shared.js";
import { approveMessageCampaign, CampaignError, cancelMessageCampaign, createMessageCampaign, getMessageCampaignDeliveries, listMessageCampaigns, pauseMessageCampaign, recordMarketingConsent, resumeMessageCampaign, retryMessageCampaignDelivery, scheduleMessageCampaign, snapshotMessageCampaign } from "./message-campaigns.js";
import { tenantCampaignMetrics } from "./campaign-observability.js";

type Auth = { tenant_id: string; role: "tenant_admin" | "supervisor" | "agent"; actor_id: string; auth_kind: "api_key" | "console_session" };

function reply(response: ServerResponse, status: number, requestId: string, body: Record<string, unknown>) {
  sendJson(response, status, { request_id: requestId, ...body });
}

async function input(request: IncomingMessage) {
  try { return JSON.parse((await readBody(request)).toString("utf8")) as Record<string, unknown>; }
  catch { throw new CampaignError("invalid_json"); }
}

function actor(auth: Auth, requestId: string) {
  if (auth.auth_kind !== "console_session") throw new CampaignError("console_session_required", 403);
  return { actor_type: "console_session" as const, actor_id: auth.actor_id, request_id: requestId };
}

export async function handleMessageCampaignApi(request: IncomingMessage, response: ServerResponse, url: URL, auth: Auth, requestId: string) {
  if (!url.pathname.startsWith("/api/v1/message-campaigns") && !url.pathname.startsWith("/api/v1/marketing-consents/")) return false;
  try {
    if (request.method === "GET" && url.pathname === "/api/v1/message-campaigns") {
      if (auth.role === "agent") throw new CampaignError("insufficient_role", 403);
      reply(response, 200, requestId, await listMessageCampaigns(auth.tenant_id));
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/message-campaigns/metrics") {
      if (auth.role === "agent") throw new CampaignError("insufficient_role", 403);
      reply(response, 200, requestId, { data: await tenantCampaignMetrics(auth.tenant_id) });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/message-campaigns") {
      if (auth.role === "agent") throw new CampaignError("insufficient_role", 403);
      const campaign = await createMessageCampaign(auth.tenant_id, await input(request), String(request.headers["idempotency-key"] ?? ""), actor(auth, requestId));
      reply(response, 201, requestId, { data: campaign });
      return true;
    }
    const snapshot = url.pathname.match(/^\/api\/v1\/message-campaigns\/([0-9a-f-]{36})\/snapshot$/i);
    if (request.method === "POST" && snapshot) {
      if (auth.role === "agent") throw new CampaignError("insufficient_role", 403);
      reply(response, 200, requestId, { data: await snapshotMessageCampaign(auth.tenant_id, snapshot[1], actor(auth, requestId)) });
      return true;
    }
    const approve = url.pathname.match(/^\/api\/v1\/message-campaigns\/([0-9a-f-]{36})\/approve$/i);
    if (request.method === "POST" && approve) {
      if (auth.role !== "tenant_admin") throw new CampaignError("tenant_admin_required", 403);
      const body = await input(request);
      reply(response, 200, requestId, { data: await approveMessageCampaign(auth.tenant_id, approve[1], String(body.reason ?? ""), actor(auth, requestId)) });
      return true;
    }
    const schedule = url.pathname.match(/^\/api\/v1\/message-campaigns\/([0-9a-f-]{36})\/schedule$/i);
    if (request.method === "POST" && schedule) {
      if (auth.role !== "tenant_admin") throw new CampaignError("tenant_admin_required", 403);
      const body = await input(request);
      reply(response, 200, requestId, { data: await scheduleMessageCampaign(auth.tenant_id, schedule[1], body, String(body.reason ?? ""), actor(auth, requestId)) });
      return true;
    }
    const cancel = url.pathname.match(/^\/api\/v1\/message-campaigns\/([0-9a-f-]{36})\/cancel$/i);
    if (request.method === "POST" && cancel) {
      if (auth.role !== "tenant_admin") throw new CampaignError("tenant_admin_required", 403);
      const body = await input(request);
      reply(response, 200, requestId, { data: await cancelMessageCampaign(auth.tenant_id, cancel[1], String(body.reason ?? ""), actor(auth, requestId)) });
      return true;
    }
    const control = url.pathname.match(/^\/api\/v1\/message-campaigns\/([0-9a-f-]{36})\/(pause|resume)$/i);
    if (request.method === "POST" && control) {
      if (auth.role !== "tenant_admin") throw new CampaignError("tenant_admin_required", 403);
      const body = await input(request);
      const operation = control[2] === "pause" ? pauseMessageCampaign : resumeMessageCampaign;
      reply(response, 200, requestId, { data: await operation(auth.tenant_id, control[1], String(body.reason ?? ""), actor(auth, requestId)) });
      return true;
    }
    const deliveryRetry = url.pathname.match(/^\/api\/v1\/message-campaigns\/([0-9a-f-]{36})\/deliveries\/([0-9a-f-]{36})\/retry$/i);
    const massReview=url.pathname.match(/^\/api\/v1\/message-campaigns\/([0-9a-f-]{36})\/mass-batches\/([0-9a-f-]{36})\/review$/i);
    if(request.method==='POST'&&massReview){
      if(auth.role!=='tenant_admin')throw new CampaignError('tenant_admin_required',403);
      const body=await input(request);
      reply(response,200,requestId,{data:await reviewMassCampaignBatch(auth.tenant_id,massReview[1],massReview[2],String(body.reason??''),actor(auth,requestId))});return true;
    }
    if (request.method === "POST" && deliveryRetry) {
      if (auth.role !== "tenant_admin") throw new CampaignError("tenant_admin_required", 403);
      const body = await input(request);
      reply(response, 200, requestId, { data: await retryMessageCampaignDelivery(auth.tenant_id, deliveryRetry[1], deliveryRetry[2], String(body.reason ?? ""), actor(auth, requestId)) });
      return true;
    }
    const details = url.pathname.match(/^\/api\/v1\/message-campaigns\/([0-9a-f-]{36})\/deliveries$/i);
    if (request.method === "GET" && details) {
      if (auth.role === "agent") throw new CampaignError("insufficient_role", 403);
      reply(response, 200, requestId, await getMessageCampaignDeliveries(auth.tenant_id, details[1], url.searchParams.get("status") ?? "all", Number(url.searchParams.get("limit") ?? 50)));
      return true;
    }
    const consent = url.pathname.match(/^\/api\/v1\/marketing-consents\/([0-9a-f-]{36})$/i);
    if (request.method === "PUT" && consent) {
      if (!['tenant_admin','supervisor'].includes(auth.role)) throw new CampaignError("insufficient_role", 403);
      const event = await recordMarketingConsent(auth.tenant_id, consent[1], await input(request), String(request.headers["idempotency-key"] ?? ""), actor(auth, requestId));
      reply(response, 201, requestId, { data: event });
      return true;
    }
    reply(response, 404, requestId, { error: { code: "not_found" } });
    return true;
  } catch (error) {
    if (!(error instanceof CampaignError)) console.error("Message campaign operation failed", error instanceof Error ? error.message : "unknown");
    const known = error instanceof CampaignError ? error : new CampaignError("campaign_operation_failed", 500);
    reply(response, known.status, requestId, { error: { code: known.code } });
    return true;
  }
}
