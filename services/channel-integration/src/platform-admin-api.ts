import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { adminSummary } from "./admin-summary-cache.js";
import {adminRecordList, type AdminRecordKind} from './admin-record-lists.js';
import { pool } from "./database.js";
import {automationRuntimeMonitor} from './automation-runtime-monitor.js';
import { DUMMY_PASSWORD_HASH, hashConsolePassword, verifyConsolePassword } from "./console-password.js";
import { hasPermission, type Permission, type PlatformRole } from "./access-control.js";
import { readBody, sendJson } from "./shared.js";
import { approveProjectionRepair, reconciliationOverview, requestProjectionRepair, runPaymentReconciliation } from "./payment-reconciliation.js";
import { requestPaymentRefund,approvePaymentRefund,rejectPaymentRefund,listPaymentRefunds } from './payment-refunds.js';
import { listWalletRequests, reviewWalletRequest } from './wallet.js';
import { WalletError } from './wallet-core.js';
import {aiPointsAdminOverview,publishAiPack,reviewAiPackRefund} from './ai-point-packs.js';
import {growthAdminOverview,publishGrowthPolicy} from './growth-policy.js';
import {searchAdminTenants} from './admin-tenant-search.js';
import {setReferralPartner} from './referral-partner-access.js';
import {publishReferralThreshold} from './referral-threshold.js';
import {referralPartnerOverview,ReferralNotFoundError} from './referral.js';
import {reviewPlanCommission} from './plan-commissions.js';
import { listPlanPricing,publishPlanPricing } from './plan-pricing.js';
import { decryptMfaSecret, encryptMfaSecret, generateTotpSecret, provisioningUri, verifyTotp } from "./platform-admin-mfa.js";
import { approveSubscriptionChange, listSubscriptionChanges, rejectSubscriptionChange, requestSubscriptionChange } from "./subscription-changes.js";
import {manualValidity} from './subscription-validity.js';
import { registrationOperationsOverview, setRegistrationEmergencyPause } from "./registration-operations.js";
import { setRegistrationSmsBudget } from "./registration-budget.js";
import {marketReviewQueue,marketReviewDetail,reviewMarketTemplate,setMarketFee,marketRefundQueue,reviewMarketRefund,marketPayouts,reviewMarketPayout} from './template-market.js';
import {TemplateMarketError} from './template-market-core.js';
import {marketPayees,revealMarketPayee,reviewMarketPayee} from './template-market.js';
import { platformCampaignDiagnostics } from "./campaign-observability.js";
import { listPlatformPrivacyRequests,transitionPrivacyRequest,platformPrivacyDetail,addPrivacyHandlingNote } from "./privacy-lifecycle.js";
import { createPilotBatch, issuePilotInvite, listPilotOperations, rehearsePilotRollback, revokePilotInvite, setPilotCheck, transitionPilotBatch } from "./registration-pilot.js";

type AdminSession = { session_id: string; admin_id: string; email: string; display_name: string; role: PlatformRole; mfa_enabled:boolean };
const ABSOLUTE_HOURS = 7 * 24;
const IDLE_MINUTES = 7 * 24 * 60;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function bearer(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization ?? "";
  const token = value.startsWith("Bearer ") ? value.slice(7).trim() : "";
  return /^[a-f0-9]{64}$/i.test(token) ? token : undefined;
}
async function json(request: IncomingMessage): Promise<Record<string, unknown>> {
  return JSON.parse((await readBody(request)).toString("utf8")) as Record<string, unknown>;
}
function reply(response: ServerResponse, status: number, requestId: string, body: Record<string, unknown>) {
  sendJson(response, status, { request_id: requestId, ...body });
}

async function monitorControl(path: string, method = "GET", body?: Record<string, unknown>): Promise<{ status: number; payload: any }> {
  const base = process.env.STATUS_MONITOR_CONTROL_URL;
  const token = process.env.STATUS_MONITOR_CONTROL_TOKEN;
  if (!base || !token || token.length < 32) return { status: 503, payload: { error: { code: "monitor_control_not_configured" } } };
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(method === "POST" && path.endsWith("/test") ? 125_000 : 12_000)
    });
    const payload = await response.json().catch(() => ({ error: { code: "invalid_monitor_response" } }));
    return { status: response.status, payload };
  } catch {
    return { status: 503, payload: { error: { code: "monitor_control_unavailable" } } };
  }
}

async function forwardMonitorControl(response: ServerResponse, requestId: string, path: string, method = "GET", body?: Record<string, unknown>) {
  const result = await monitorControl(path, method, body);
  reply(response, result.status, requestId, result.payload);
  return result;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid_${field}`);
  return parsed;
}

function optionalPriceMinor(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).trim();
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(text)) throw new Error("invalid_price");
  const [yuan, fraction = ""] = text.split(".");
  return Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
}

async function session(request: IncomingMessage): Promise<AdminSession | undefined> {
  const token = bearer(request);
  if (!token) return undefined;
  const found = await pool.query<AdminSession>(
    `SELECT s.session_id,a.admin_id,a.email,a.display_name,a.role,(a.mfa_enabled_at IS NOT NULL) AS mfa_enabled
       FROM platform_admin_sessions s JOIN platform_admin_accounts a ON a.admin_id=s.admin_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>NOW()
        AND s.last_seen_at>NOW()-($2::text||' minutes')::interval
        AND a.status='active' AND a.session_version=s.admin_session_version`, [hash(token), IDLE_MINUTES]);
  if (!found.rows[0]) return undefined;
  await pool.query(`UPDATE platform_admin_sessions SET last_seen_at=NOW() WHERE session_id=$1`, [found.rows[0].session_id]);
  return found.rows[0];
}

function allowed(admin: AdminSession, permission: Permission): boolean {
  return hasPermission({ domain: "platform", role: admin.role }, permission);
}

async function audit(admin: AdminSession, action: string, resourceType: string, resourceId: string, requestId: string, values: { tenant_id?: string; target_user_id?: string; reason?: string; after?: unknown; impersonation_id?: string } = {}) {
  await pool.query(
    `INSERT INTO platform_admin_audit_logs
      (actor_admin_id,actor_role,action,resource_type,resource_id,tenant_id,target_platform_user_id,reason,after_data,request_id,impersonation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [admin.admin_id, admin.role, action, resourceType, resourceId, values.tenant_id ?? null, values.target_user_id ?? null,
      values.reason ?? null, values.after === undefined ? null : JSON.stringify(values.after), requestId, values.impersonation_id ?? null]);
}

async function login(request: IncomingMessage, response: ServerResponse, requestId: string) {
  let body: Record<string, unknown>;
  try { body = await json(request); } catch { return reply(response, 400, requestId, { error: { code: "invalid_request" } }); }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const mfaCode = typeof body.mfa_code === "string" ? body.mfa_code.trim() : "";
  const recoveryCode = typeof body.recovery_code === "string" ? body.recovery_code.trim().toUpperCase() : "";
  const found = await pool.query<{ admin_id: string; password_hash: string; failed_login_attempts: number; locked_until: Date | null; mfa_secret_ciphertext:string|null;mfa_enabled_at:Date|null;recovery_code_hashes:string[] }>(
    `SELECT admin_id,password_hash,failed_login_attempts,locked_until,mfa_secret_ciphertext,mfa_enabled_at,recovery_code_hashes FROM platform_admin_accounts WHERE email=$1 AND status='active'`, [email]);
  const account = found.rows[0];
  const passwordValid = await verifyConsolePassword(password, account?.password_hash ?? DUMMY_PASSWORD_HASH);
  const recoveryHash=recoveryCode?hash(recoveryCode):"";
  const recoveryValid=Boolean(recoveryHash&&account?.recovery_code_hashes?.includes(recoveryHash));
  const mfaValid = !account?.mfa_enabled_at || recoveryValid || Boolean(account.mfa_secret_ciphertext && verifyTotp(decryptMfaSecret(account.mfa_secret_ciphertext),mfaCode));
  const valid = passwordValid && mfaValid;
  if (!account || !valid || (account.locked_until && account.locked_until > new Date())) {
    if (account) await pool.query(`UPDATE platform_admin_accounts SET failed_login_attempts=failed_login_attempts+1,locked_until=CASE WHEN failed_login_attempts+1>=5 THEN NOW()+INTERVAL '30 minutes' ELSE locked_until END,updated_at=NOW() WHERE admin_id=$1`, [account.admin_id]);
    return reply(response, 401, requestId, { error: { code: passwordValid && account?.mfa_enabled_at ? "mfa_required" : "invalid_credentials" } });
  }
  const token = randomBytes(32).toString("hex");
  const issued = await pool.query<{ session_id: string }>(
    `INSERT INTO platform_admin_sessions(token_hash,admin_id,admin_session_version,expires_at)
     SELECT $1,admin_id,session_version,NOW()+($2::text||' hours')::interval FROM platform_admin_accounts WHERE admin_id=$3 RETURNING session_id`,
    [hash(token), ABSOLUTE_HOURS, account.admin_id]);
  await pool.query(`UPDATE platform_admin_accounts SET failed_login_attempts=0,locked_until=NULL,last_login_at=NOW(),updated_at=NOW() WHERE admin_id=$1`, [account.admin_id]);
  if(recoveryValid)await pool.query(`UPDATE platform_admin_accounts SET recovery_code_hashes=array_remove(recovery_code_hashes,$2),updated_at=NOW() WHERE admin_id=$1`,[account.admin_id,recoveryHash]);
  const admin = await pool.query<AdminSession>(`SELECT $1::uuid AS session_id,admin_id,email,display_name,role,(mfa_enabled_at IS NOT NULL) AS mfa_enabled FROM platform_admin_accounts WHERE admin_id=$2`, [issued.rows[0].session_id, account.admin_id]);
  await audit(admin.rows[0], "platform_admin.logged_in", "platform_admin_session", issued.rows[0].session_id, requestId);
  reply(response, 200, requestId, { data: { token, expires_in: ABSOLUTE_HOURS * 3600 } });
}

async function overview(response: ServerResponse, admin: AdminSession, requestId: string) {
  const result = await adminSummary('overview',()=>pool.query(`SELECT
    (SELECT COUNT(*)::int FROM tenants) AS tenants,
    (SELECT COUNT(*)::int FROM platform_users WHERE status='active') AS active_users,
    (SELECT COUNT(*)::int FROM payment_orders) AS payment_orders,
    (SELECT COALESCE(SUM(amount_minor),0)::bigint FROM payment_orders WHERE status IN ('paid','partially_refunded','refunded')) AS gross_paid_minor,
    (SELECT COUNT(*)::int FROM payment_ledger_outbox WHERE status IN ('pending','processing','dead')) AS payment_queue,
    (SELECT COUNT(*)::int FROM gateway_events WHERE status IN ('pending','processing','dead')) AS inbound_queue,
    (SELECT COUNT(*)::int FROM notification_deliveries WHERE status IN ('pending','retry_pending','failed')) AS notification_queue,
    (SELECT COUNT(*)::int FROM quota_notification_jobs WHERE status IN ('pending','failed')) AS quota_warning_queue`));
  reply(response, 200, requestId, { data: result.rows[0] });
}

async function listData(response: ServerResponse, kind: string, requestId: string, params: URLSearchParams) {
  if (kind === "tenants") {
    try { return reply(response,200,requestId,{data:await searchAdminTenants(params.get('q')??'',params.get('page'),true)}); }
    catch(error) { if(error instanceof Error && error.message==='invalid_search') return reply(response,400,requestId,{error:{code:'invalid_search'}}); throw error; }
  }
  if (kind === "orders") {
    const rows = await pool.query(`SELECT o.payment_order_id,o.order_number,o.tenant_id,t.name AS tenant_name,o.product_code,o.provider,o.amount_minor,o.refunded_minor,o.status,o.created_at
      FROM payment_orders o JOIN tenants t ON t.tenant_id=o.tenant_id ORDER BY o.created_at DESC LIMIT 100`);
    return reply(response, 200, requestId, { data: rows.rows });
  }
  if (kind === "finance") {
    const rows = await adminSummary('finance',()=>pool.query(`SELECT t.currency,COUNT(DISTINCT t.transaction_id)::int AS posted_transactions,
      COALESCE(SUM(CASE WHEN t.transaction_type='topup' AND e.account='cash' AND e.direction='credit' THEN e.amount_minor ELSE 0 END),0)::bigint AS payments_minor,
      COALESCE(SUM(CASE WHEN t.transaction_type IN ('refund','reversal') AND e.account='cash' AND e.direction='debit' THEN e.amount_minor ELSE 0 END),0)::bigint AS reversals_minor
      FROM ledger_transactions t LEFT JOIN ledger_entries e ON e.transaction_id=t.transaction_id WHERE t.status='posted' GROUP BY t.currency ORDER BY t.currency`));
    return reply(response, 200, requestId, { data: rows.rows });
  }
  if (kind === "queues") {
    const rows = await adminSummary('queues',()=>pool.query(`SELECT 'payment_ledger_outbox' AS queue,status,COUNT(*)::int AS count FROM payment_ledger_outbox GROUP BY status
      UNION ALL SELECT 'gateway_events',status,COUNT(*)::int FROM gateway_events GROUP BY status
      UNION ALL SELECT 'notification_deliveries',status,COUNT(*)::int FROM notification_deliveries GROUP BY status
      UNION ALL SELECT 'quota_notification_jobs',status,COUNT(*)::int FROM quota_notification_jobs GROUP BY status ORDER BY queue,status`));
    return reply(response, 200, requestId, { data: rows.rows });
  }
  if (kind === "settings") {
    return reply(response, 200, requestId, { data: {
      payment: { provider: process.env.PAYMENT_PROVIDER ?? "disabled", mode: process.env.PAYMENT_MODE ?? "sandbox", live_enabled: process.env.PAYMENT_LIVE_ENABLED === "true" },
      knowledge_storage: process.env.KNOWLEDGE_STORAGE_PROVIDER ?? "filesystem",
      outbound_notifications: process.env.ENTERPRISE_WECHAT_NOTIFICATION_MODE ?? "dry_run"
    } });
  }
  if (kind === "audit") {
    const rows = await pool.query(`SELECT audit_id,'platform_admin' AS source,actor_admin_id::text AS actor_id,actor_role,action,resource_type,resource_id,tenant_id,reason,request_id,created_at FROM platform_admin_audit_logs
      UNION ALL SELECT audit_id,'tenant' AS source,actor_id,NULL,action,resource_type,resource_id,tenant_id,reason,request_id,created_at FROM audit_logs
      ORDER BY created_at DESC LIMIT 200`);
    return reply(response, 200, requestId, { data: rows.rows });
  }
  if (kind === "admins") {
    const page=Number(params.get('page')??1),q=(params.get('q')??'').trim();
    if(!Number.isInteger(page)||page<1||page>10000||q.length>100)return reply(response,400,requestId,{error:{code:'invalid_search'}});
    const pattern='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
    const rows = await pool.query(`SELECT admin_id,email,display_name,role,status,(mfa_enabled_at IS NOT NULL) AS mfa_enabled,last_login_at,created_at FROM platform_admin_accounts
      WHERE ($1='' OR email ILIKE $2 OR display_name ILIKE $2) ORDER BY created_at,admin_id LIMIT 21 OFFSET $3`,[q,pattern,(page-1)*20]);
    return reply(response, 200, requestId, { data: {items:rows.rows.slice(0,20),page,has_more:rows.rows.length>20} });
  }
  if (kind === "reconciliation") return reply(response, 200, requestId, { data: await reconciliationOverview(params) });
  if (kind === "subscription-changes") return reply(response, 200, requestId, { data: await listSubscriptionChanges(params) });
  if (kind === "registration") return reply(response, 200, requestId, { data: await registrationOperationsOverview() });
  if (kind === "campaigns") {
    try{return reply(response,200,requestId,{data:await platformCampaignDiagnostics(params)});}
    catch(e){if(e instanceof Error&&e.message==='invalid_search')return reply(response,400,requestId,{error:{code:'invalid_search'}});throw e;}
  }
  if (kind === "privacy-requests") return reply(response, 200, requestId, { data: await listPlatformPrivacyRequests(pool,params) });
  if (kind === "pilot") return reply(response, 200, requestId, { data: await listPilotOperations() });
}

async function createAdmin(request:IncomingMessage,response:ServerResponse,admin:AdminSession,requestId:string){let body:Record<string,unknown>;try{body=await json(request)}catch{return reply(response,400,requestId,{error:{code:"invalid_request"}})}const email=typeof body.email==="string"?body.email.trim().toLowerCase():"",display=typeof body.display_name==="string"?body.display_name.trim():"",role=body.role as PlatformRole,password=typeof body.password==="string"?body.password:"";if(!/^\S+@\S+\.\S+$/.test(email)||!display||!['owner','admin','support','auditor'].includes(role))return reply(response,400,requestId,{error:{code:"invalid_admin"}});try{const passwordHash=await hashConsolePassword(password);const inserted=await pool.query<{admin_id:string}>(`INSERT INTO platform_admin_accounts(email,display_name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING admin_id`,[email,display,passwordHash,role]);await audit(admin,"platform_admin.created","platform_admin_account",inserted.rows[0].admin_id,requestId,{after:{email,display_name:display,role}});reply(response,201,requestId,{data:{admin_id:inserted.rows[0].admin_id}})}catch{reply(response,409,requestId,{error:{code:"admin_create_failed"}})}}

async function updateAdmin(request:IncomingMessage,response:ServerResponse,admin:AdminSession,targetId:string,requestId:string){let body:Record<string,unknown>;try{body=await json(request)}catch{return reply(response,400,requestId,{error:{code:"invalid_request"}})}const role=body.role as PlatformRole,status=body.status as string,reason=typeof body.reason==="string"?body.reason.trim():"";if(!['owner','admin','support','auditor'].includes(role)||!['active','disabled'].includes(status)||reason.length<10)return reply(response,400,requestId,{error:{code:"invalid_admin_update"}});if(targetId===admin.admin_id&&status==='disabled')return reply(response,409,requestId,{error:{code:"cannot_disable_self"}});const before=await pool.query<{role:string;status:string}>(`SELECT role,status FROM platform_admin_accounts WHERE admin_id=$1`,[targetId]);if(!before.rows[0])return reply(response,404,requestId,{error:{code:"admin_not_found"}});if(before.rows[0].role==='owner'&&(role!=='owner'||status==='disabled')){const owners=await pool.query<{count:number}>(`SELECT COUNT(*)::int AS count FROM platform_admin_accounts WHERE role='owner' AND status='active'`);if(owners.rows[0].count<=1)return reply(response,409,requestId,{error:{code:"last_owner_protected"}})}await pool.query(`UPDATE platform_admin_accounts SET role=$2,status=$3,session_version=session_version+1,updated_at=NOW() WHERE admin_id=$1`,[targetId,role,status]);await pool.query(`UPDATE platform_admin_sessions SET revoked_at=COALESCE(revoked_at,NOW()),revoke_reason=COALESCE(revoke_reason,'admin_changed') WHERE admin_id=$1`,[targetId]);await audit(admin,"platform_admin.updated","platform_admin_account",targetId,requestId,{reason,after:{role,status}});reply(response,200,requestId,{data:{updated:true}})}

async function enrollMfa(response:ServerResponse,admin:AdminSession,requestId:string){const secret=generateTotpSecret(),ciphertext=encryptMfaSecret(secret);await pool.query(`UPDATE platform_admin_accounts SET mfa_pending_ciphertext=$2,mfa_pending_expires_at=NOW()+INTERVAL '10 minutes',updated_at=NOW() WHERE admin_id=$1`,[admin.admin_id,ciphertext]);await audit(admin,"platform_admin.mfa_enrollment_started","platform_admin_account",admin.admin_id,requestId);reply(response,200,requestId,{data:{secret,provisioning_uri:provisioningUri(admin.email,secret),expires_in:600}})}
async function pendingMfa(response:ServerResponse,admin:AdminSession,requestId:string){const found=await pool.query<{mfa_pending_ciphertext:string}>(`SELECT mfa_pending_ciphertext FROM platform_admin_accounts WHERE admin_id=$1 AND mfa_pending_expires_at>NOW()`,[admin.admin_id]);if(!found.rows[0]?.mfa_pending_ciphertext)return reply(response,404,requestId,{error:{code:"no_pending_enrollment"}});const secret=decryptMfaSecret(found.rows[0].mfa_pending_ciphertext);reply(response,200,requestId,{data:{secret,provisioning_uri:provisioningUri(admin.email,secret)}})}
async function confirmMfa(request:IncomingMessage,response:ServerResponse,admin:AdminSession,requestId:string){let body:Record<string,unknown>;try{body=await json(request)}catch{return reply(response,400,requestId,{error:{code:"invalid_request"}})}const code=typeof body.code==="string"?body.code:"";const found=await pool.query<{mfa_pending_ciphertext:string}>(`SELECT mfa_pending_ciphertext FROM platform_admin_accounts WHERE admin_id=$1 AND mfa_pending_expires_at>NOW()`,[admin.admin_id]);if(!found.rows[0]||!verifyTotp(decryptMfaSecret(found.rows[0].mfa_pending_ciphertext),code))return reply(response,401,requestId,{error:{code:"invalid_mfa_code"}});const recovery=Array.from({length:8},()=>randomBytes(5).toString("hex").toUpperCase());await pool.query(`UPDATE platform_admin_accounts SET mfa_secret_ciphertext=mfa_pending_ciphertext,mfa_pending_ciphertext=NULL,mfa_pending_expires_at=NULL,mfa_enabled_at=NOW(),recovery_code_hashes=$2,updated_at=NOW() WHERE admin_id=$1`,[admin.admin_id,recovery.map(hash)]);await audit(admin,"platform_admin.mfa_enabled","platform_admin_account",admin.admin_id,requestId);reply(response,200,requestId,{data:{enabled:true,recovery_codes:recovery}})}

async function startImpersonation(request: IncomingMessage, response: ServerResponse, admin: AdminSession, requestId: string) {
  let body: Record<string, unknown>;
  try { body = await json(request); } catch { return reply(response, 400, requestId, { error: { code: "invalid_request" } }); }
  const tenantId = typeof body.tenant_id === "string" ? body.tenant_id : "";
  const userId = typeof body.platform_user_id === "string" ? body.platform_user_id : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !tenantId || reason.length < 10 || reason.length > 500) return reply(response, 400, requestId, { error: { code: "invalid_impersonation_request" } });
  const target = await pool.query(`SELECT 1 FROM tenant_memberships m JOIN platform_users u ON u.platform_user_id=m.platform_user_id JOIN tenants t ON t.tenant_id=m.tenant_id WHERE m.tenant_id=$1 AND m.platform_user_id=$2 AND m.status='active' AND u.status='active' AND t.status IN ('active','test')`, [tenantId, userId]);
  if (!target.rows[0]) return reply(response, 404, requestId, { error: { code: "target_not_found" } });
  const ticket = randomBytes(32).toString("hex");
  const inserted = await pool.query<{ impersonation_id: string }>(`INSERT INTO platform_impersonations(admin_id,target_platform_user_id,tenant_id,reason,ticket_hash,expires_at) VALUES($1,$2,$3,$4,$5,NOW()+INTERVAL '60 seconds') RETURNING impersonation_id`, [admin.admin_id, userId, tenantId, reason, hash(ticket)]);
  await audit(admin, "impersonation.started", "tenant_membership", `${tenantId}:${userId}`, requestId, { tenant_id: tenantId, target_user_id: userId, reason, impersonation_id: inserted.rows[0].impersonation_id });
  reply(response, 201, requestId, { data: { ticket, expires_in: 60 } });
}

export async function exchangeImpersonationTicket(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/v1/auth/impersonation-exchange") return false;
  const requestId = randomUUID();
  if (request.method !== "POST") { reply(response, 405, requestId, { error: { code: "method_not_allowed" } }); return true; }
  let body: Record<string, unknown>;
  try { body = await json(request); } catch { reply(response, 400, requestId, { error: { code: "invalid_request" } }); return true; }
  const ticket = typeof body.ticket === "string" ? body.ticket : "";
  if (!/^[a-f0-9]{64}$/i.test(ticket)) { reply(response, 401, requestId, { error: { code: "invalid_ticket" } }); return true; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{ impersonation_id: string; admin_id: string; target_platform_user_id: string; tenant_id: string }>(`SELECT impersonation_id,admin_id,target_platform_user_id,tenant_id FROM platform_impersonations WHERE ticket_hash=$1 AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE`, [hash(ticket)]);
    const item = found.rows[0];
    if (!item) { await client.query("ROLLBACK"); reply(response, 401, requestId, { error: { code: "invalid_ticket" } }); return true; }
    const consoleToken=randomBytes(32).toString("hex");
    const issued=await client.query<{session_id:string}>(`INSERT INTO console_sessions(token_hash,platform_user_id,selected_tenant_id,user_session_version,expires_at,impersonation_id,impersonated_by_admin_id)
      SELECT $1,u.platform_user_id,$2,u.session_version,NOW()+INTERVAL '4 hours',$3,$4 FROM platform_users u WHERE u.platform_user_id=$5 AND u.status='active' RETURNING session_id`,[hash(consoleToken),item.tenant_id,item.impersonation_id,item.admin_id,item.target_platform_user_id]);
    if(!issued.rows[0]) throw new Error("impersonation_target_inactive");
    await client.query(`UPDATE platform_impersonations SET consumed_at=NOW(),console_session_id=$2 WHERE impersonation_id=$1`, [item.impersonation_id, issued.rows[0].session_id]);
    await client.query("COMMIT");
    reply(response, 200, requestId, { data: { token: consoleToken, expires_in: 4*3600 } });
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  return true;
}

export async function auditImpersonatedRequest(auth: { impersonation_id: string | null; impersonated_by_admin_id: string | null; tenant_id: string; platform_user_id: string | null; role: string }, request: IncomingMessage, url: URL, requestId: string) {
  if (!auth.impersonation_id || !auth.impersonated_by_admin_id) return;
  await pool.query(`INSERT INTO platform_admin_audit_logs(actor_admin_id,actor_role,action,resource_type,resource_id,tenant_id,target_platform_user_id,after_data,request_id,impersonation_id)
    SELECT $1,a.role,'impersonation.request','api_endpoint',$2,$3,$4,jsonb_build_object('method',$5::text,'tenant_role',$6::text),$7,$8 FROM platform_admin_accounts a WHERE a.admin_id=$1`,
    [auth.impersonated_by_admin_id, url.pathname, auth.tenant_id, auth.platform_user_id, request.method ?? "GET", auth.role, requestId, auth.impersonation_id]);
}

export async function handlePlatformAdminApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/v1/platform-admin/")) return false;
  const requestId = randomUUID();
  if (request.method === "POST" && url.pathname === "/api/v1/platform-admin/auth/login") { await login(request, response, requestId); return true; }
  const admin = await session(request);
  if (!admin) { reply(response, 401, requestId, { error: { code: "session_expired" } }); return true; }
  if(url.pathname.startsWith('/api/v1/platform-admin/template-market')) {
    if(!['owner','admin'].includes(admin.role)){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
    try {
      const path=url.pathname.slice('/api/v1/platform-admin/template-market'.length);let data:unknown;
      if(request.method==='GET'&&path==='')data=await marketReviewQueue(admin.admin_id,Number(url.searchParams.get('offset')??0));
      else if(request.method==='GET'&&path==='/refunds')data=await marketRefundQueue(admin.admin_id,Number(url.searchParams.get('offset')??0));
      else if(request.method==='GET'&&path==='/payees')data=await marketPayees(admin.admin_id,null,Number(url.searchParams.get('offset')??0));
      else if(request.method==='POST'&&['/payee-reveal','/payee-review'].includes(path)){
        const b=await json(request);if(typeof b.payee_id!=='string'||!/^[0-9a-f-]{36}$/i.test(b.payee_id)||b.confirmed!==true)throw new TemplateMarketError('invalid_market_request');
        data=path==='/payee-reveal'?await revealMarketPayee(admin.admin_id,b.payee_id,String(b.note??''),requestId):await reviewMarketPayee(admin.admin_id,b.payee_id,String(b.action??''),String(b.note??''),requestId);
      }
      else if(request.method==='GET'&&path==='/payouts')data=await marketPayouts(admin.admin_id,null,Number(url.searchParams.get('offset')??0));
      else if(request.method==='POST'&&path==='/payout-review'){
        const b=await json(request);if(typeof b.payout_id!=='string'||!/^[0-9a-f-]{36}$/i.test(b.payout_id)||b.confirmed!==true)throw new TemplateMarketError('invalid_market_request');
        data=await reviewMarketPayout(admin.admin_id,b.payout_id,b.action as 'approve'|'reject'|'paid',String(b.note??''),b.payment_reference,requestId,b.confirmed_unpaid===true);
      }
      else if(request.method==='POST'&&path==='/refund-review'){const b=await json(request);if(typeof b.order_id!=='string'||!/^[0-9a-f-]{36}$/i.test(b.order_id))throw new TemplateMarketError('invalid_market_request');data=await reviewMarketRefund(admin.admin_id,b.order_id,b.action as 'approve'|'reject',String(b.note??''),requestId);}
      else if(request.method==='GET'&&/^\/[0-9a-f-]{36}$/i.test(path))data=await marketReviewDetail(admin.admin_id,path.slice(1));
      else if(request.method==='POST'&&path==='/review') {const b=await json(request);if(typeof b.listing_id!=='string'||!/^[0-9a-f-]{36}$/i.test(b.listing_id))throw new TemplateMarketError('invalid_market_request');data=await reviewMarketTemplate(admin.admin_id,b.listing_id,b.action as 'publish'|'reject'|'withdraw',String(b.note??''),requestId);}
      else if(request.method==='POST'&&path==='/fee'){const b=await json(request);data=await setMarketFee(admin.admin_id,b.fee_bps,b.expected_version,String(b.note??''),requestId);}
      else{reply(response,404,requestId,{error:{code:'not_found'}});return true;}
      reply(response,200,requestId,{data});
    }catch(e){reply(response,e instanceof TemplateMarketError?409:503,requestId,{error:{code:e instanceof TemplateMarketError?e.message:'market_unavailable'}});}return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/platform-admin/auth/logout") {
    await pool.query(`UPDATE platform_admin_sessions SET revoked_at=NOW(),revoke_reason='logout' WHERE session_id=$1`, [admin.session_id]);
    await audit(admin, "platform_admin.logged_out", "platform_admin_session", admin.session_id, requestId);
    reply(response, 200, requestId, { data: { logged_out: true } }); return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/platform-admin/auth/session") { reply(response, 200, requestId, { data: { user: admin } }); return true; }
  if(request.method==="POST"&&url.pathname==="/api/v1/platform-admin/mfa/enroll"){await enrollMfa(response,admin,requestId);return true}
  if(request.method==="GET"&&url.pathname==="/api/v1/platform-admin/mfa/pending"){await pendingMfa(response,admin,requestId);return true}
  if(request.method==="POST"&&url.pathname==="/api/v1/platform-admin/mfa/confirm"){await confirmMfa(request,response,admin,requestId);return true}
  if (request.method === "GET" && url.pathname === "/api/v1/platform-admin/overview" && allowed(admin, "platform.dashboard.read")) { await overview(response, admin, requestId); return true; }
  if (request.method === "GET" && url.pathname === "/api/v1/platform-admin/monitor") {
    if (!allowed(admin, "platform.settings.read")) { reply(response,403,requestId,{error:{code:"forbidden"}}); return true; }
    const history=url.searchParams.get('automation_history')==='1',page=Number(url.searchParams.get('page')??1);
    if(history&&(!Number.isInteger(page)||page<1||page>100)){reply(response,400,requestId,{error:{code:'invalid_page'}});return true;}
    await forwardMonitorControl(response, requestId, history?`/monitor?automation_history=1&page=${page}`:"/monitor"); return true;
  }
  if(request.method==='GET'&&url.pathname==='/api/v1/platform-admin/monitor/automation'){
    if(!allowed(admin,'platform.settings.read')){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
    reply(response,200,requestId,{data:automationRuntimeMonitor.privateHealth()});return true;
  }
  if (request.method === "PATCH" && url.pathname === "/api/v1/platform-admin/monitor/config") {
    if (!['owner','admin'].includes(admin.role)) { reply(response,403,requestId,{error:{code:"forbidden"}}); return true; }
    let body:Record<string,unknown>; try { body=await json(request); } catch { reply(response,400,requestId,{error:{code:"invalid_request"}}); return true; }
    const result=await monitorControl("/monitor/config","PATCH",body);
    if(result.status<300)await audit(admin,"status_monitor.config_updated","status_monitor","primary",requestId,{after:result.payload.data});
    reply(response,result.status,requestId,result.payload);return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/platform-admin/monitor/destinations") {
    if (!['owner','admin'].includes(admin.role)) { reply(response,403,requestId,{error:{code:"forbidden"}}); return true; }
    let body:Record<string,unknown>; try { body=await json(request); } catch { reply(response,400,requestId,{error:{code:"invalid_request"}}); return true; }
    const result=await monitorControl("/monitor/destinations","POST",body);
    if(result.status<300)await audit(admin,"status_monitor.destination_created","status_alert_destination",String(result.payload.data?.destination_id??"unknown"),requestId,{after:result.payload.data});
    reply(response,result.status,requestId,result.payload);return true;
  }
  const monitorDestination=url.pathname.match(/^\/api\/v1\/platform-admin\/monitor\/destinations\/([0-9a-f-]{36})(?:\/(test))?$/i);
  if(monitorDestination&&['PATCH','DELETE','POST'].includes(request.method??"")){
    if (!['owner','admin'].includes(admin.role)) { reply(response,403,requestId,{error:{code:"forbidden"}}); return true; }
    const body=request.method==="PATCH"?await json(request):undefined;
    const suffix=monitorDestination[2]?"/test":"";
    const result=await monitorControl(`/monitor/destinations/${monitorDestination[1]}${suffix}`,request.method??"POST",body);
    if(result.status<300)await audit(admin,monitorDestination[2]?"status_monitor.destination_tested":request.method==="DELETE"?"status_monitor.destination_deleted":"status_monitor.destination_updated","status_alert_destination",monitorDestination[1],requestId,{after:result.payload.data});
    reply(response,result.status,requestId,result.payload);return true;
  }
  const monitorIncident=url.pathname.match(/^\/api\/v1\/platform-admin\/monitor\/incidents\/([0-9a-f-]{36})\/acknowledge$/i);
  if(monitorIncident&&request.method==="POST"){
    if (!['owner','admin','support'].includes(admin.role)) { reply(response,403,requestId,{error:{code:"forbidden"}}); return true; }
    const result=await monitorControl(`/monitor/incidents/${monitorIncident[1]}/acknowledge`,"POST",{acknowledged_by:`${admin.display_name} (${admin.email})`});
    if(result.status<300)await audit(admin,"status_monitor.incident_acknowledged","status_incident",monitorIncident[1],requestId,{after:result.payload.data});
    reply(response,result.status,requestId,result.payload);return true;
  }
  const kind = url.pathname.split("/").at(-1) ?? "";
  if(url.pathname==='/api/v1/platform-admin/referral-partners'){
    if(!['owner','admin'].includes(admin.role)){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
    try{
      if(request.method==='GET'){
        const tenant=url.searchParams.get('tenant_id')??'';if(!tenant||tenant.length>200)throw Error('invalid_partner_change');
        reply(response,200,requestId,{data:await referralPartnerOverview(tenant)});return true;
      }
      if(request.method==='POST'){
        reply(response,200,requestId,{data:await setReferralPartner(await json(request),admin.admin_id,requestId)});return true;
      }
      reply(response,405,requestId,{error:{code:'method_not_allowed'}});
    }catch(e){
      const code=e instanceof ReferralNotFoundError?'tenant_not_found':e instanceof Error?e.message:'';
      const known:Record<string,number>={forbidden:403,tenant_not_found:404,active_tenant_required:409,invalid_partner_change:400,partner_version_conflict:409,referral_partner_disabled:409};
      if(code in known)reply(response,known[code],requestId,{error:{code}});else throw e;
    }return true;
  }
  if(url.pathname==='/api/v1/platform-admin/tenant-search'&&request.method==='GET'){
    if(!['owner','admin'].includes(admin.role)){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
    try{reply(response,200,requestId,{data:await searchAdminTenants(url.searchParams.get('q')??'',url.searchParams.get('page'))});}catch{reply(response,400,requestId,{error:{code:'invalid_search'}});}return true;
  }
  if(url.pathname==='/api/v1/platform-admin/subscription-mail'&&request.method==='GET'){
    if(!['owner','admin'].includes(admin.role)){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
    const counts=(await pool.query(`SELECT status,COUNT(*)::int AS count FROM subscription_mail_deliveries GROUP BY status`)).rows;
    const waiting=Number((await pool.query(`SELECT COUNT(*)::int AS count FROM subscription_mail_events WHERE status='pending'`)).rows[0].count);
    const issues=(await pool.query(`SELECT * FROM (
      (SELECT d.delivery_id,d.status,d.error_code,d.attempts,d.updated_at,t.name AS tenant_name,e.kind FROM subscription_mail_deliveries d JOIN subscription_mail_events e USING(event_id) JOIN tenants t USING(tenant_id) WHERE d.status IN ('retry','review') ORDER BY d.updated_at DESC LIMIT 20)
      UNION ALL
      (SELECT d.delivery_id,d.status,d.error_code,d.attempts,d.updated_at,t.name AS tenant_name,'ai_points_low' AS kind FROM ai_low_mail_deliveries d JOIN ai_low_mail_events e USING(event_id) JOIN tenants t USING(tenant_id) WHERE d.status IN ('retry','review') ORDER BY d.updated_at DESC LIMIT 20)
    ) recent ORDER BY updated_at DESC LIMIT 20`)).rows;
    reply(response,200,requestId,{data:{counts,waiting,issues}});return true;
  }
  const recordList=url.pathname.match(/^\/api\/v1\/platform-admin\/records\/(wallet|refunds|commissions)$/);
  if(recordList&&request.method==='GET'){
    if(!allowed(admin,'platform.finance.read')){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
    try{reply(response,200,requestId,{data:await adminRecordList(recordList[1] as AdminRecordKind,url.searchParams)});}
    catch(e){if(e instanceof Error&&e.message==='invalid_search')reply(response,400,requestId,{error:{code:'invalid_search'}});else throw e;}
    return true;
  }
  const commissionReview=url.pathname.match(/^\/api\/v1\/platform-admin\/growth-policy\/commissions\/([0-9a-f-]{36})\/(approve|reject)$/i);
  if(commissionReview&&request.method==='POST'){
    if(!['owner','admin'].includes(admin.role)){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
    try{const body=await json(request);reply(response,200,requestId,{data:await reviewPlanCommission(commissionReview[1],commissionReview[2],body.reason,admin.admin_id,admin.role,requestId)});}catch{reply(response,409,requestId,{error:{code:'review_failed'}});}return true;
  }
  if(url.pathname==='/api/v1/platform-admin/referral-threshold'&&request.method==='POST'){
    if(!['owner','admin'].includes(admin.role)){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
    try{reply(response,200,requestId,{data:await publishReferralThreshold(await json(request),admin.admin_id,requestId)});}
    catch(e){const code=e instanceof Error?e.message:'';const known:Record<string,number>={forbidden:403,invalid_referral_threshold:400,version_conflict:409,referral_campaign_unavailable:409};reply(response,known[code]??503,requestId,{error:{code:known[code]?code:'referral_threshold_unavailable'}});}return true;
  }
  if(url.pathname==='/api/v1/platform-admin/growth-policy'){
    if(!allowed(admin,'platform.finance.read')){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
    if(request.method==='GET'){reply(response,200,requestId,{data:await growthAdminOverview(url.searchParams.get('summary_only')!=='1')});return true;}
    if(request.method==='POST'){
      if(!['owner','admin'].includes(admin.role)){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
      try{reply(response,201,requestId,{data:await publishGrowthPolicy(await json(request),admin.admin_id,admin.role,requestId)});}
      catch(e){reply(response,409,requestId,{error:{code:e instanceof Error?e.message:'growth_policy_unavailable'}});}return true;
    }
  }
  if(url.pathname==='/api/v1/platform-admin/ai-points'){
    if(!allowed(admin,'platform.finance.read')){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
    if(request.method==='GET'){try{reply(response,200,requestId,{data:await aiPointsAdminOverview(url.searchParams)});}catch(e){if(e instanceof Error&&e.message==='invalid_search')reply(response,400,requestId,{error:{code:'invalid_search'}});else throw e;}return true;}
    if(request.method==='POST'){
      if(!['owner','admin'].includes(admin.role)){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
      try{const body=await json(request),result=await publishAiPack(body,admin.admin_id);await audit(admin,'ai_points.price_published','ai_point_pack',result.pack_version_id,requestId,{reason:String(body.reason),after:result});reply(response,201,requestId,{data:result});}
      catch(e){reply(response,e instanceof WalletError?e.status:503,requestId,{error:{code:e instanceof WalletError?e.code:'ai_points_unavailable'}});}return true;
    }
  }
  const pointRefund=url.pathname.match(/^\/api\/v1\/platform-admin\/ai-points\/refunds\/([0-9a-f-]{36})\/(approve|reject)$/i);
  if(pointRefund&&request.method==='POST'){
    if(!['owner','admin'].includes(admin.role)){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
    try{reply(response,200,requestId,{data:await reviewAiPackRefund(pointRefund[1],pointRefund[2],admin.admin_id,await json(request),requestId)});}catch(e){reply(response,e instanceof WalletError?e.status:503,requestId,{error:{code:e instanceof WalletError?e.code:'ai_points_unavailable'}});}return true;
  }
  if(url.pathname==='/api/v1/platform-admin/wallet-requests'&&request.method==='GET'){
    if(!allowed(admin,'platform.finance.read')){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
    reply(response,200,requestId,{data:await listWalletRequests()});return true;
  }
  const walletReview=url.pathname.match(/^\/api\/v1\/platform-admin\/wallet-requests\/([0-9a-f-]{36})\/(approve|reject|paid)$/i);
  if(walletReview&&request.method==='POST'){
    if(!['owner','admin'].includes(admin.role)){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
    try{const body=await json(request),result=await reviewWalletRequest(walletReview[1],walletReview[2],admin.admin_id,body,requestId);
      await audit(admin,`wallet.${walletReview[2]}`,'wallet_request',result.request_id,requestId,{tenant_id:result.tenant_id,reason:String(body.reason),after:{status:result.status,net_minor:result.net_minor}});
      reply(response,200,requestId,{data:result});}
    catch(e){reply(response,e instanceof WalletError?e.status:409,requestId,{error:{code:e instanceof WalletError?e.code:'wallet_action_failed'}});}return true;
  }
  if(url.pathname==='/api/v1/platform-admin/plan-pricing'){
    if(!allowed(admin,'platform.subscriptions.manage')){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
    if(request.method==='GET'){reply(response,200,requestId,{data:await listPlanPricing()});return true;}
    if(request.method==='POST'){
      try{const body=await json(request),result=await publishPlanPricing(body,admin.admin_id);
        await audit(admin,'plan.price_published','plan_catalog_version',result.plan_version_id,requestId,{reason:String(body.reason),after:result});
        reply(response,201,requestId,{data:result});
      }catch{reply(response,409,requestId,{error:{code:'pricing_publish_failed',message:'请检查价格、原因和版本后重试'}});}
      return true;
    }
  }
  if(url.pathname==='/api/v1/platform-admin/payment-refunds'&&request.method==='GET'){
    if(!allowed(admin,'platform.finance.read')){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
    reply(response,200,requestId,{data:await listPaymentRefunds()});return true;
  }
  const refundAction=url.pathname.match(/^\/api\/v1\/platform-admin\/payment-refunds(?:\/([0-9a-f-]{36})\/(approve|reject))?$/i);
  if(refundAction&&request.method==='POST'){
    if(!['owner','admin'].includes(admin.role)){reply(response,403,requestId,{error:{code:'forbidden'}});return true;}
    try {
      const body=await json(request);const reason=typeof body.reason==='string'?body.reason.trim():'';
      if(reason.length<10||reason.length>256)throw new Error('reason_required');
      const result=refundAction[2]==='approve'?await approvePaymentRefund(refundAction[1],admin.admin_id)
        :refundAction[2]==='reject'?await rejectPaymentRefund(refundAction[1])
        :await requestPaymentRefund(String(body.payment_order_id??''),admin.admin_id,reason);
      await audit(admin,`payment.refund_${refundAction[2]??'request'}`,'payment_refund_request',result.refund_request_id,requestId,{reason,after:result});
      reply(response,200,requestId,{data:result});
    }catch{reply(response,409,requestId,{error:{code:'refund_action_unavailable',message:'退款操作未完成；请检查订单状态、审批人和原因'}});}
    return true;
  }
  const permissions: Record<string, Permission> = { tenants: "platform.tenants.read", orders: "platform.orders.read", finance: "platform.finance.read", queues: "platform.queues.read", settings: "platform.settings.read", audit: "platform.audit.read", admins: "platform.admins.manage", reconciliation: "platform.finance.read", "subscription-changes": "platform.subscriptions.manage", registration: "platform.registration.read", pilot: "platform.registration.read", campaigns: "platform.campaigns.read", "privacy-requests": "platform.privacy.read" };
  if (request.method === "GET" && permissions[kind]) {
    if (!allowed(admin, permissions[kind])) { reply(response, 403, requestId, { error: { code: "forbidden" } }); return true; }
    try{await listData(response, kind, requestId, url.searchParams);}catch(e){if(e instanceof Error&&e.message==='invalid_search')reply(response,400,requestId,{error:{code:'invalid_search'}});else throw e;} return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/platform-admin/impersonations") {
    if (!allowed(admin, "platform.impersonation.start")) { reply(response, 403, requestId, { error: { code: "forbidden" } }); return true; }
    await startImpersonation(request, response, admin, requestId); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/platform-admin/registration/budget") {
    if (!allowed(admin,"platform.registration.manage")) { reply(response,403,requestId,{error:{code:"forbidden"}}); return true; }
    let body: Record<string,unknown>;
    try { body = await json(request); } catch { reply(response,400,requestId,{error:{code:"invalid_request"}}); return true; }
    try {
      const result = await setRegistrationSmsBudget({limit:body.limit,expected_limit:body.expected_limit,reason:typeof body.reason === "string" ? body.reason : "",admin_id:admin.admin_id,actor_role:admin.role,request_id:requestId});
      reply(response,200,requestId,{data:result});
    } catch(error) {
      const code = error instanceof Error ? error.message : "budget_update_failed";
      const known = ["invalid_sms_budget","reason_required","sms_budget_changed_reload","forbidden"].includes(code);
      reply(response,known ? 409 : 500,requestId,{error:{code:known ? code : "budget_update_failed"}});
    }
    return true;
  }
  if(request.method==="POST"&&url.pathname==="/api/v1/platform-admin/admins"){if(!allowed(admin,"platform.admins.manage")){reply(response,403,requestId,{error:{code:"forbidden"}});return true}await createAdmin(request,response,admin,requestId);return true}
  if(request.method==="POST"&&url.pathname==="/api/v1/platform-admin/registration/control"){if(!allowed(admin,"platform.registration.manage")){reply(response,403,requestId,{error:{code:"forbidden"}});return true}let body:Record<string,unknown>;try{body=await json(request)}catch{reply(response,400,requestId,{error:{code:"invalid_request"}});return true}const action=body.action,reason=typeof body.reason==="string"?body.reason.trim():"";if((action!=="pause"&&action!=="resume")||reason.length<10||reason.length>500){reply(response,400,requestId,{error:{code:"invalid_registration_control"}});return true}try{const result=await setRegistrationEmergencyPause({action,reason,admin_id:admin.admin_id,actor_role:admin.role,request_id:requestId});reply(response,200,requestId,{data:result})}catch(error){reply(response,409,requestId,{error:{code:error instanceof Error?error.message:"registration_control_failed"}})}return true}
  if(request.method==="POST"&&url.pathname==="/api/v1/platform-admin/pilot/batches"){if(!allowed(admin,"platform.registration.manage")){reply(response,403,requestId,{error:{code:"forbidden"}});return true}let body:Record<string,unknown>;try{body=await json(request)}catch{reply(response,400,requestId,{error:{code:"invalid_request"}});return true}try{const result=await createPilotBatch({...body,admin_id:admin.admin_id,request_id:requestId});await audit(admin,"pilot.batch_created","registration_pilot_batch",result.pilot_batch_id,requestId,{after:result});reply(response,201,requestId,{data:result})}catch(error){reply(response,409,requestId,{error:{code:error instanceof Error?error.message:"pilot_batch_create_failed"}})}return true}
  const pilotCheck=url.pathname.match(/^\/api\/v1\/platform-admin\/pilot\/batches\/([0-9a-f-]{36})\/checks$/i);if(pilotCheck&&request.method==="POST"){if(!allowed(admin,"platform.registration.manage")){reply(response,403,requestId,{error:{code:"forbidden"}});return true}const body=await json(request);try{const result=await setPilotCheck({pilot_batch_id:pilotCheck[1],check_key:String(body.check_key??""),passed:String(body.passed)==="true",evidence:body.evidence,admin_id:admin.admin_id,request_id:requestId});reply(response,200,requestId,{data:result})}catch(error){reply(response,409,requestId,{error:{code:error instanceof Error?error.message:"pilot_check_failed"}})}return true}
  const pilotRollback=url.pathname.match(/^\/api\/v1\/platform-admin\/pilot\/batches\/([0-9a-f-]{36})\/rollback-rehearsal$/i);if(pilotRollback&&request.method==="POST"){if(!allowed(admin,"platform.registration.manage")){reply(response,403,requestId,{error:{code:"forbidden"}});return true}try{const result=await rehearsePilotRollback(pilotRollback[1],admin.admin_id,requestId);await audit(admin,"pilot.rollback_rehearsed","registration_pilot_batch",pilotRollback[1],requestId,{after:result});reply(response,200,requestId,{data:result})}catch(error){reply(response,409,requestId,{error:{code:error instanceof Error?error.message:"pilot_rollback_rehearsal_failed"}})}return true}
  const pilotTransition=url.pathname.match(/^\/api\/v1\/platform-admin\/pilot\/batches\/([0-9a-f-]{36})\/transition$/i);if(pilotTransition&&request.method==="POST"){if(!allowed(admin,"platform.registration.manage")){reply(response,403,requestId,{error:{code:"forbidden"}});return true}const body=await json(request);try{const result=await transitionPilotBatch(pilotTransition[1],String(body.action??""),body.reason,admin.admin_id,requestId);await audit(admin,"pilot.batch_transitioned","registration_pilot_batch",pilotTransition[1],requestId,{reason:String(body.reason??""),after:result});reply(response,200,requestId,{data:result})}catch(error){reply(response,409,requestId,{error:{code:error instanceof Error?error.message:"pilot_transition_failed"}})}return true}
  const pilotIssue=url.pathname.match(/^\/api\/v1\/platform-admin\/pilot\/batches\/([0-9a-f-]{36})\/invites$/i);if(pilotIssue&&request.method==="POST"){if(!allowed(admin,"platform.registration.manage")){reply(response,403,requestId,{error:{code:"forbidden"}});return true}const body=await json(request);try{const result=await issuePilotInvite(pilotIssue[1],body.recipient_ref,admin.admin_id,requestId);await audit(admin,"pilot.invite_issued","registration_pilot_invite",result.pilot_invite_id,requestId,{after:{display_hint:result.display_hint,pilot_batch_id:pilotIssue[1]}});reply(response,201,requestId,{data:result})}catch(error){reply(response,409,requestId,{error:{code:error instanceof Error?error.message:"pilot_invite_issue_failed"}})}return true}
  const pilotRevoke=url.pathname.match(/^\/api\/v1\/platform-admin\/pilot\/invites\/([0-9a-f-]{36})\/revoke$/i);if(pilotRevoke&&request.method==="POST"){if(!allowed(admin,"platform.registration.manage")){reply(response,403,requestId,{error:{code:"forbidden"}});return true}const body=await json(request);try{const result=await revokePilotInvite(pilotRevoke[1],body.reason,admin.admin_id,requestId);await audit(admin,"pilot.invite_revoked","registration_pilot_invite",pilotRevoke[1],requestId,{reason:String(body.reason??"")});reply(response,200,requestId,{data:result})}catch(error){reply(response,409,requestId,{error:{code:error instanceof Error?error.message:"pilot_invite_revoke_failed"}})}return true}
  const privacyDetail=url.pathname.match(/^\/api\/v1\/platform-admin\/privacy-requests\/([0-9a-f-]{36})$/i);
  if(privacyDetail&&request.method==='GET'){
    if(!allowed(admin,'platform.privacy.read')){reply(response,403,requestId,{error:{code:'forbidden'}});return true}
    try{const data=await platformPrivacyDetail(privacyDetail[1],url.searchParams);reply(response,data?200:404,requestId,data?{data}:{error:{code:'privacy_request_not_found'}})}catch{reply(response,400,requestId,{error:{code:'invalid_search'}})}return true;
  }
  const privacyMatch=url.pathname.match(/^\/api\/v1\/platform-admin\/privacy-requests\/([0-9a-f-]{36})\/(transition|notes)$/i);
  if(privacyMatch&&request.method==='POST'){
    if(!allowed(admin,'platform.privacy.manage')){reply(response,403,requestId,{error:{code:'forbidden'}});return true}
    let body:Record<string,unknown>;try{body=await json(request)}catch{reply(response,400,requestId,{error:{code:'invalid_request'}});return true}
    try{
      const common={privacy_request_id:privacyMatch[1],reason:body.reason,admin_id:admin.admin_id,request_id:requestId};
      const result=privacyMatch[2]==='notes'?await addPrivacyHandlingNote(common):await transitionPrivacyRequest({...common,next_status:String(body.next_status??''),legal_hold_reason:body.legal_hold_reason,identity_verified:body.identity_verified,manual_completed:body.manual_completed});
      await audit(admin,privacyMatch[2]==='notes'?'privacy_request.note_added':'privacy_request.transitioned','privacy_request',privacyMatch[1],requestId,{after:result});
      reply(response,200,requestId,{data:result});
    }catch(error){const code=error instanceof Error?error.message:'';const safe=['privacy_request_not_found','privacy_request_reason_required','privacy_note_requires_review','invalid_privacy_request_status','invalid_privacy_request_transition','privacy_identity_confirmation_required','privacy_manual_completion_required','privacy_partial_reason_required','privacy_request_concurrent_update'];reply(response,409,requestId,{error:{code:safe.includes(code)?code:'privacy_request_transition_failed'}})}return true;
  }
  const adminMatch=url.pathname.match(/^\/api\/v1\/platform-admin\/admins\/([0-9a-f-]{36})$/i);if(adminMatch&&request.method==="PATCH"){if(!allowed(admin,"platform.admins.manage")){reply(response,403,requestId,{error:{code:"forbidden"}});return true}await updateAdmin(request,response,admin,adminMatch[1],requestId);return true}
  if(request.method==="POST"&&url.pathname==="/api/v1/platform-admin/subscriptions/change-requests"){if(!allowed(admin,"platform.subscriptions.manage")){reply(response,403,requestId,{error:{code:"forbidden"}});return true}let body:Record<string,unknown>;try{body=await json(request)}catch{reply(response,400,requestId,{error:{code:"invalid_request"}});return true}const tenantId=typeof body.tenant_id==="string"?body.tenant_id:"",plan=typeof body.target_plan_code==="string"?body.target_plan_code:"",reason=typeof body.reason==="string"?body.reason.trim():"";try{const validity=manualValidity(body.validity_mode??'days',body.validity_days??30);const overrides={validity_mode:validity.days===null?'unlimited' as const:'days' as const,validity_days:validity.days??undefined,price_minor:optionalPriceMinor(body.price_yuan),seat_limit:optionalInteger(body.seat_limit,"seat_limit"),channel_limit:optionalInteger(body.channel_limit,"channel_limit"),customer_limit:optionalInteger(body.customer_limit,"customer_limit"),ai_actions_monthly:body.ai_points_monthly!==undefined&&body.ai_points_monthly!==""?(()=>{const n=optionalInteger(body.ai_points_monthly,"ai_points_monthly")!;if(n%10!==0)throw Error("points_must_be_multiple_of_10");return n/10;})():optionalInteger(body.ai_actions_monthly,"ai_actions_monthly"),knowledge_bytes:body.knowledge_mb===""||body.knowledge_mb===undefined?undefined:(optionalInteger(body.knowledge_mb,"knowledge_mb")??0)*1048576,automation_rule_limit:optionalInteger(body.automation_rule_limit,"automation_rule_limit"),qr_code_limit:optionalInteger(body.qr_code_limit,"qr_code_limit"),audit_retention_days:optionalInteger(body.audit_retention_days,"audit_retention_days")};const result=await requestSubscriptionChange(tenantId,plan,admin.admin_id,reason,overrides);const action=result.status==="executed"?"subscription.changed_single_admin":"subscription.change_requested";await audit(admin,action,"subscription_change_request",String(result.change_request_id),requestId,{tenant_id:tenantId,reason,after:{target_plan_code:plan,status:result.status,approval_mode:result.approval_mode,overrides}});reply(response,201,requestId,{data:result})}catch(error){reply(response,409,requestId,{error:{code:error instanceof Error?error.message:"change_request_failed"}})}return true}
  const subscriptionDecision=url.pathname.match(/^\/api\/v1\/platform-admin\/subscriptions\/change-requests\/([0-9a-f-]{36})\/(approve|reject)$/i);if(subscriptionDecision&&request.method==="POST"){if(!allowed(admin,"platform.subscriptions.manage")){reply(response,403,requestId,{error:{code:"forbidden"}});return true}let body:Record<string,unknown>;try{body=await json(request)}catch{reply(response,400,requestId,{error:{code:"invalid_request"}});return true}const reason=typeof body.reason==="string"?body.reason.trim():"";try{const result=subscriptionDecision[2]==="approve"?await approveSubscriptionChange(subscriptionDecision[1],admin.admin_id,reason):await rejectSubscriptionChange(subscriptionDecision[1],admin.admin_id,reason);await audit(admin,subscriptionDecision[2]==="approve"?"subscription.change_approved_and_executed":"subscription.change_rejected","subscription_change_request",subscriptionDecision[1],requestId,{reason,after:result});reply(response,200,requestId,{data:result})}catch(error){reply(response,409,requestId,{error:{code:error instanceof Error?error.message:"change_decision_failed"}})}return true}
  const repairRequestMatch=url.pathname.match(/^\/api\/v1\/platform-admin\/reconciliation\/differences\/([0-9a-f-]{36})\/repair-requests$/i);if(repairRequestMatch&&request.method==="POST"){if(!['owner','admin'].includes(admin.role)){reply(response,403,requestId,{error:{code:"forbidden"}});return true}const body=await json(request),reason=typeof body.reason==="string"?body.reason.trim():"";if(reason.length<10){reply(response,400,requestId,{error:{code:"reason_required"}});return true}try{const result=await requestProjectionRepair(repairRequestMatch[1],admin.admin_id,reason);await audit(admin,result.status==="executed"?"payment.repair_single_admin_executed":"payment.repair_requested","payment_reconciliation_difference",repairRequestMatch[1],requestId,{reason,after:result});reply(response,201,requestId,{data:result})}catch{reply(response,409,requestId,{error:{code:"repair_not_available"}})}return true}
  const approveMatch=url.pathname.match(/^\/api\/v1\/platform-admin\/reconciliation\/repair-requests\/([0-9a-f-]{36})\/approve$/i);if(approveMatch&&request.method==="POST"){if(!['owner','admin'].includes(admin.role)){reply(response,403,requestId,{error:{code:"forbidden"}});return true}const body=await json(request),reason=typeof body.reason==="string"?body.reason.trim():"";if(reason.length<10){reply(response,400,requestId,{error:{code:"reason_required"}});return true}try{const result=await approveProjectionRepair(approveMatch[1],admin.admin_id,reason);await audit(admin,"payment.repair_approved_and_executed","payment_repair_request",approveMatch[1],requestId,{reason,after:result});reply(response,200,requestId,{data:result})}catch(error){reply(response,409,requestId,{error:{code:error instanceof Error?error.message:"repair_failed"}})}return true}
  if (request.method === "POST" && url.pathname === "/api/v1/platform-admin/reconciliation/run") {
    if (!allowed(admin,"platform.finance.read")) { reply(response,403,requestId,{error:{code:"forbidden"}}); return true; }
    const result=await runPaymentReconciliation(); await audit(admin,"payment.reconciliation_run","payment_reconciliation_run",result.run_id,requestId,{after:result}); reply(response,200,requestId,{data:result}); return true;
  }
  reply(response, 404, requestId, { error: { code: "not_found" } }); return true;
}
