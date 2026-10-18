import { createHash, randomUUID } from "node:crypto";
import { handleExtensionsApi } from "./extensions-api.js";
import { handleExternalApi, handleOpenAppManagement } from "./open-platform-api.js";
import { handleWorkbenchExtensions } from "./workbench-extensions-api.js";
import { sharedWechatConfig } from "./shared-wechat-config.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "./database.js";
import { handlePhase4Api } from "./phase4-api.js";
import { readBody, requiredEnv, sendJson } from "./shared.js";
import { issueChatwootSsoLink } from "./chatwoot-sso-adapter.js";
import { authenticateConsoleSession, handleConsoleAuthApi } from "./console-auth.js";
import { handleMemberLifecycleApi, handlePublicIdentityLifecycleApi } from "./identity-lifecycle.js";
import { handleCommunicationsApi } from "./communications-api.js";
import { handleChannelConnectionsApi } from "./channel-connections-api.js";
import { handleOutboundApi } from "./outbound-api.js";
import { handleCopilotContextApi } from "./copilot-context-api.js";
import { handleOperationsMetricsApi } from "./operations-metrics.js";
import { handleNotificationsApi } from "./notifications-api.js";
import { handleBrowserPushApi } from "./browser-push-api.js";
import { handleNotificationDestinationsApi } from "./notification-destinations-api.js";
import { handleInboundApi } from "./inbound-api.js";
import { handleBillingApi } from "./billing-api.js";
import { handleTrialApi } from "./trial-api.js";
import { handleReferralApi } from "./referral-api.js";
import { handlePlatformAdminApi, exchangeImpersonationTicket, auditImpersonatedRequest } from "./platform-admin-api.js";
import { handleRegistrationApi } from "./registration-api.js";
import { handleMessageCampaignApi } from "./message-campaign-api.js";
import { handlePrivacyApi } from "./privacy-api.js";
import { copilotEmbedRouteAllowed } from "./copilot-embed-session-core.js";
import { handleSocialChannelApi } from "./social-channel-api.js";
import { handleConversationHeadlessApi } from "./conversation-headless-api.js";
import type {AutomaticSenderPort} from './automatic-sender.js';
import { handlePublicWebChat, handleWebChatApi } from "./web-chat-api.js";
import { handleQuickRepliesApi } from "./quick-replies-api.js";
import { handleTemplateMarketApi } from './template-market-api.js';
import { handleFileTransfersApi, handlePublicFileTransferApi } from "./file-transfers-api.js";
import { handleSharedWechatManagement } from "./shared-wechat-management-api.js";
import { createSharedOfficialQr } from "./wechat-official.js";
import { secretValue } from "./secret-value.js";
import {captureSecurityOperation,handleTenantSecurityApi} from './tenant-security.js';
import {createCustomerInsightsApi} from './customer-insights-api.js';
import {createInsightAccessPort} from './customer-insights-access.js';
const customerInsightsApi=createCustomerInsightsApi(pool,{enabled:()=>process.env.AI_CUSTOMER_INSIGHTS_ENABLED==='true',
 access:(a,e)=>createInsightAccessPort(pool,{origin:requiredEnv('CHATWOOT_BASE_URL'),secret:secretValue('REPLYNEST_AUTOMATIC_REPLY_SECRET')??''})(a,e)});

export type AuthContext = {
  key_id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_status: string;
  role: "tenant_admin" | "supervisor" | "agent";
  platform_user_id: string | null;
  auth_kind: "api_key" | "console_session";
  actor_id: string;
  impersonation_id: string | null;
  impersonated_by_admin_id: string | null;
  session_scope: "console" | "copilot_embed" | null;
};

function apiResponse(response: ServerResponse, status: number, requestId: string, body: Record<string, unknown>): void {
  sendJson(response, status, { request_id: requestId, ...body });
}

async function authenticate(request: IncomingMessage): Promise<AuthContext | undefined> {
  const authorization = request.headers.authorization ?? "";
  if (!authorization.startsWith("Bearer ")) return undefined;
  const rawKey = authorization.slice(7).trim();
  if (!/^[a-f0-9]{64}$/i.test(rawKey)) return undefined;
  const consoleSession = await authenticateConsoleSession(request);
  if (consoleSession?.tenant_id && consoleSession.tenant_name && consoleSession.tenant_status && consoleSession.role) {
    return {
      key_id: consoleSession.session_id,
      tenant_id: consoleSession.tenant_id,
      tenant_name: consoleSession.tenant_name,
      tenant_status: consoleSession.tenant_status,
      role: consoleSession.role,
      platform_user_id: consoleSession.platform_user_id,
      auth_kind: "console_session",
      actor_id: consoleSession.platform_user_id
      ,impersonation_id: consoleSession.impersonation_id
      ,impersonated_by_admin_id: consoleSession.impersonated_by_admin_id
      ,session_scope: consoleSession.session_scope
    };
  }
  const hash = createHash("sha256").update(rawKey).digest("hex");
  const result = await pool.query<AuthContext>(
    `SELECT k.key_id, k.tenant_id, k.role, k.platform_user_id,
            t.name AS tenant_name, t.status AS tenant_status
       FROM tenant_api_keys k JOIN tenants t ON t.tenant_id=k.tenant_id
      WHERE k.key_hash=$1 AND k.status='active' AND t.status IN ('active', 'test')`,
    [hash]
  );
  if (!result.rows[0]) return undefined;
  await pool.query(`UPDATE tenant_api_keys SET last_used_at=NOW() WHERE key_id=$1`, [result.rows[0].key_id]);
  return { ...result.rows[0], auth_kind: "api_key", actor_id: result.rows[0].key_id, impersonation_id: null, impersonated_by_admin_id: null, session_scope: null };
}

async function createChatwootLoginLink(response: ServerResponse, auth: AuthContext, requestId: string) {
  if (!auth.platform_user_id) {
    return apiResponse(response, 409, requestId, { error: { code: "identity_mapping_required", message: "当前账号尚未映射到 Chatwoot 成员" } });
  }
  const mapping = await pool.query<{ chatwoot_user_email: string; chatwoot_account_id: string }>(
    `SELECT m.chatwoot_user_email,m.chatwoot_account_id
       FROM tenant_memberships m JOIN tenants t ON t.tenant_id=m.tenant_id
      WHERE m.tenant_id=$1 AND m.platform_user_id=$2 AND m.status='active'
        AND t.status IN ('active','test') AND m.chatwoot_account_id=t.chatwoot_account_id`,
    [auth.tenant_id, auth.platform_user_id]
  );
  if (!mapping.rows[0]) {
    return apiResponse(response, 403, requestId, { error: { code: "membership_disabled", message: "当前成员无权进入客服工作台" } });
  }
  try {
    const ticket = await issueChatwootSsoLink(
      { email: mapping.rows[0].chatwoot_user_email, account_id: Number(mapping.rows[0].chatwoot_account_id) },
      {
        internalBaseUrl: requiredEnv("CHATWOOT_BASE_URL"),
        publicBaseUrl: requiredEnv("CHATWOOT_PUBLIC_URL"),
        sharedSecret: requiredEnv("SAAS_SSO_SHARED_SECRET")
      }
    );
    await pool.query(
      `INSERT INTO audit_logs
        (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
       VALUES ($1,'platform_user',$2,'session.chatwoot_ticket_issued','chatwoot_account',$3,
               jsonb_build_object('expires_in',$4::int),$5)`,
      [auth.tenant_id, auth.platform_user_id, mapping.rows[0].chatwoot_account_id, ticket.expires_in, requestId]
    );
    return apiResponse(response, 200, requestId, { data: ticket });
  } catch (error) {
    console.warn("Chatwoot SSO exchange failed", error instanceof Error ? error.message : String(error));
    return apiResponse(response, 503, requestId, { error: { code: "chatwoot_sso_unavailable", message: "客服工作台登录暂不可用，请稍后重试" } });
  }
}

function safeLimit(value: string | null): number {
  const parsed = Number(value ?? 20);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(parsed, 100)) : 20;
}

async function listCustomers(auth: AuthContext, url: URL) {
  const limit = safeLimit(url.searchParams.get("limit"));
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const offset = (page - 1) * limit;
  const result = await pool.query(
    `SELECT customer_id, name, phone, email, attributes, first_seen_at, last_seen_at, created_at, updated_at
       FROM customers WHERE tenant_id=$1 ORDER BY updated_at DESC, customer_id LIMIT $2 OFFSET $3`,
    [auth.tenant_id, limit + 1, offset]
  );
  const hasNext = result.rows.length > limit;
  return { data: result.rows.slice(0, limit), pagination: { page, limit, has_next: hasNext } };
}

async function getCustomer(auth: AuthContext, customerId: string) {
  const customer = await pool.query(
    `SELECT customer_id, name, phone, email, attributes, first_seen_at, last_seen_at, created_at, updated_at
       FROM customers WHERE tenant_id=$1 AND customer_id=$2`,
    [auth.tenant_id, customerId]
  );
  if (!customer.rows[0]) return undefined;
  const identities = await pool.query(
    `SELECT identity_id, channel, external_user_id, sync_status, last_synced_at,
            chatwoot_contact_id, chatwoot_conversation_id
       FROM channel_identities WHERE tenant_id=$1 AND customer_id=$2 ORDER BY created_at`,
    [auth.tenant_id, customerId]
  );
  return { ...customer.rows[0], channel_identities: identities.rows };
}

async function patchCustomer(request: IncomingMessage, response: ServerResponse, auth: AuthContext, customerId: string, requestId: string) {
  if (!['tenant_admin', 'supervisor'].includes(auth.role)) {
    return apiResponse(response, 403, requestId, { error: { code: "forbidden", message: "当前角色不能修改客户资料" } });
  }
  const idempotencyKey = String(request.headers["idempotency-key"] ?? "").trim();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return apiResponse(response, 400, requestId, { error: { code: "idempotency_key_required", message: "需要有效的 Idempotency-Key" } });
  }
  const input = JSON.parse((await readBody(request)).toString("utf8")) as Record<string, unknown>;
  const supplied = ["name", "phone", "email"].filter(key => Object.hasOwn(input, key));
  if (!supplied.length || Object.keys(input).some(key => !["name", "phone", "email"].includes(key))) {
    return apiResponse(response, 400, requestId, { error: { code: "invalid_fields", message: "仅允许修改 name、phone、email" } });
  }
  if (Object.hasOwn(input, "name") && (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200)) {
    return apiResponse(response, 400, requestId, { error: { code: "invalid_name", message: "客户名称不合法" } });
  }
  for (const key of ["phone", "email"] as const) {
    if (Object.hasOwn(input, key) && input[key] !== null && (typeof input[key] !== "string" || input[key].length > 320)) {
      return apiResponse(response, 400, requestId, { error: { code: `invalid_${key}`, message: `${key} 不合法` } });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const replay = await client.query(
      `SELECT response_status, response_body FROM idempotency_requests
        WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE`,
      [auth.tenant_id, idempotencyKey]
    );
    if (replay.rows[0]) {
      await client.query("COMMIT");
      return sendJson(response, replay.rows[0].response_status, replay.rows[0].response_body);
    }
    const before = await client.query(
      `SELECT customer_id, name, phone, email FROM customers WHERE tenant_id=$1 AND customer_id=$2 FOR UPDATE`,
      [auth.tenant_id, customerId]
    );
    if (!before.rows[0]) {
      await client.query("ROLLBACK");
      return apiResponse(response, 404, requestId, { error: { code: "customer_not_found", message: "客户不存在" } });
    }
    const updated = await client.query(
      `UPDATE customers SET
         name=CASE WHEN $3 THEN $4 ELSE name END,
         phone=CASE WHEN $5 THEN $6 ELSE phone END,
         email=CASE WHEN $7 THEN $8 ELSE email END,
         updated_at=NOW()
       WHERE tenant_id=$1 AND customer_id=$2
       RETURNING customer_id, name, phone, email, attributes, first_seen_at, last_seen_at, created_at, updated_at`,
      [auth.tenant_id, customerId,
       Object.hasOwn(input, "name"), typeof input.name === "string" ? input.name.trim() : null,
       Object.hasOwn(input, "phone"), input.phone ?? null,
       Object.hasOwn(input, "email"), input.email ?? null]
    );
    const responseBody = { request_id: requestId, data: updated.rows[0] };
    await client.query(
      `INSERT INTO audit_logs
        (tenant_id, actor_type, actor_id, action, resource_type, resource_id, before_data, after_data, request_id)
       VALUES ($1, 'tenant_api_key', $2, 'customer.updated', 'customer', $3, $4, $5, $6)`,
      [auth.tenant_id, auth.key_id, customerId, before.rows[0], updated.rows[0], requestId]
    );
    await client.query(
      `INSERT INTO idempotency_requests
        (tenant_id, idempotency_key, endpoint, response_status, response_body)
       VALUES ($1, $2, $3, 200, $4)`,
      [auth.tenant_id, idempotencyKey, `PATCH /api/v1/customers/${customerId}`, responseBody]
    );
    await client.query("COMMIT");
    return sendJson(response, 200, responseBody);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function handleBusinessApi(request: IncomingMessage, response: ServerResponse, url: URL, options:{sender?:AutomaticSenderPort}={}): Promise<boolean> {
  if (!url.pathname.startsWith("/api/v1/")) return false;
  if (await handleExternalApi(request,response,url)) return true;
  if (await handlePublicWebChat(request, response, url)) return true;
  if (await handlePlatformAdminApi(request, response, url)) return true;
  if (await exchangeImpersonationTicket(request, response, url)) return true;
  if (await handleRegistrationApi(request, response, url)) return true;
  if (await handlePublicIdentityLifecycleApi(request, response, url)) return true;
  if (await handlePublicFileTransferApi(request, response, url)) return true;
  if (await handleConsoleAuthApi(request, response, url)) return true;
  const requestId = randomUUID();
  const auth = await authenticate(request);
  if (!auth) {
    apiResponse(response, 401, requestId, { error: { code: "unauthorized", message: "API Key 无效或已撤销" } });
    return true;
  }
  if (auth.session_scope === "copilot_embed") {
    if (!copilotEmbedRouteAllowed(request.method, url.pathname)) {
      apiResponse(response, 403, requestId, { error: { code: "session_scope_forbidden", message: "Copilot 嵌入会话无权访问该接口" } });
      return true;
    }
  }
  captureSecurityOperation(request,response,url,auth,requestId);
  if(await handleTenantSecurityApi(request,response,url,auth,requestId))return true;
  if(await customerInsightsApi(request,response,url,auth,requestId))return true;
  if (auth.impersonation_id && auth.impersonated_by_admin_id) {
    await auditImpersonatedRequest(auth, request, url, requestId);
  }
  if (await handleMemberLifecycleApi(request, response, url, auth, requestId)) return true;
  if (await handleOpenAppManagement(request,response,url,auth,requestId)) return true;
  if (await handleWorkbenchExtensions(request,response,url,auth,requestId)) return true;
  if (await handleExtensionsApi(request, response, url, auth, requestId)) return true;
  if (await handleCommunicationsApi(request, response, url, auth, requestId)) return true;
  if (await handleWebChatApi(request, response, url, auth, requestId)) return true;
  if (await handleSharedWechatManagement(request,response,url,auth,requestId,{
    db:pool,enabled:process.env.SHARED_WECHAT_MANAGEMENT_ENABLED==="true",
    options:{appId:process.env.SHARED_WECHAT_APP_ID??"",entryReady:process.env.SHARED_WECHAT_ENTRY_ENABLED==="true",
      issueQr:async (scene,permanent)=>createSharedOfficialQr(scene,await sharedWechatConfig(),permanent?null:600)}
  })) return true;
  if (await handleChannelConnectionsApi(request, response, url, auth, requestId)) return true;
  if (await handleSocialChannelApi(request, response, url, auth, requestId)) return true;
  if (await handleConversationHeadlessApi(request, response, url, auth, requestId,options)) return true;
  if (await handleFileTransfersApi(request, response, url, auth, requestId)) return true;
  if (await handleQuickRepliesApi(request, response, url, auth, requestId)) return true;
  if (await handleTemplateMarketApi(request, response, url, auth, requestId)) return true;
  if (await handleOutboundApi(request, response, url, auth, requestId)) return true;
  if (await handleMessageCampaignApi(request, response, url, auth, requestId)) return true;
  if (await handleInboundApi(request, response, url, auth, requestId)) return true;
  if (await handleCopilotContextApi(request, response, url, auth, requestId)) return true;
  if (await handleOperationsMetricsApi(request, response, url, auth, requestId)) return true;
  if (await handleNotificationDestinationsApi(request, response, url, auth, requestId)) return true;
  if (await handleNotificationsApi(request, response, url, auth, requestId)) return true;
  if (await handleBrowserPushApi(request, response, url, auth, requestId)) return true;
  if (await handleBillingApi(request, response, url, auth, requestId)) return true;
  if (await handleTrialApi(request, response, url, auth, requestId)) return true;
  if (await handleReferralApi(request, response, url, auth, requestId)) return true;
  if (await handlePrivacyApi(request, response, url, auth, requestId)) return true;
  if (await handlePhase4Api(request, response, url, auth, requestId)) return true;
  if (request.method === "POST" && url.pathname === "/api/v1/session/chatwoot-link") {
    apiResponse(response,410,requestId,{error:{code:'legacy_workspace_retired',message:'请使用答巢客服工作台'},data:{workbench_path:'/workbench'}});
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/me") {
    apiResponse(response, 200, requestId, { data: { tenant_id: auth.tenant_id, tenant_name: auth.tenant_name, tenant_status: auth.tenant_status, role: auth.role } });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/customers") {
    apiResponse(response, 200, requestId, await listCustomers(auth, url));
    return true;
  }
  const customerMatch = url.pathname.match(/^\/api\/v1\/customers\/([0-9a-f-]{36})$/i);
  if (customerMatch && request.method === "GET") {
    const customer = await getCustomer(auth, customerMatch[1]);
    apiResponse(response, customer ? 200 : 404, requestId, customer ? { data: customer } : { error: { code: "customer_not_found", message: "客户不存在" } });
    return true;
  }
  if (customerMatch && request.method === "PATCH") {
    await patchCustomer(request, response, auth, customerMatch[1], requestId);
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/audit-logs") {
    if (auth.role !== "tenant_admin") {
      apiResponse(response, 403, requestId, { error: { code: "forbidden", message: "仅企业管理员可查看审计日志" } });
      return true;
    }
    const limit = safeLimit(url.searchParams.get("limit"));
    const logs = await pool.query(
      `SELECT audit_id, actor_type, action, resource_type, resource_id, reason, before_data, after_data, request_id, created_at
         FROM audit_logs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [auth.tenant_id, limit]
    );
    apiResponse(response, 200, requestId, { data: logs.rows, pagination: { limit } });
    return true;
  }
  apiResponse(response, 404, requestId, { error: { code: "not_found", message: "接口不存在" } });
  return true;
}
