import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "./database.js";
import { readBody, sendJson } from "./shared.js";
import { DUMMY_PASSWORD_HASH, verifyConsolePassword } from "./console-password.js";
import { verifyCaptchaToken } from "./captcha.js";
import {recordSecurityLogin,captureSecurityOperation} from './tenant-security.js';

// Tenant-console sessions are intentionally long-lived on trusted devices. They
// remain revocable through session_version, explicit logout and account state.
const SESSION_ABSOLUTE_SECONDS = 7 * 24 * 60 * 60;
const SESSION_IDLE_MINUTES = 7 * 24 * 60;

export type ConsoleSessionContext = {
  session_id: string;
  platform_user_id: string;
  email: string;
  display_name: string;
  tenant_id: string | null;
  tenant_name: string | null;
  tenant_status: string | null;
  role: "tenant_admin" | "supervisor" | "agent" | null;
  impersonation_id: string | null;
  impersonated_by_admin_id: string | null;
  impersonated_by_name: string | null;
  session_scope: "console" | "copilot_embed";
};

type Workspace = {
  tenant_id: string;
  tenant_name: string;
  tenant_status: string;
  role: "tenant_admin" | "supervisor" | "agent";
};

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization ?? "";
  if (!authorization.startsWith("Bearer ")) return undefined;
  const token = authorization.slice(7).trim();
  return /^[a-f0-9]{64}$/i.test(token) ? token : undefined;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function listWorkspaces(platformUserId: string): Promise<Workspace[]> {
  const result = await pool.query<Workspace>(
    `SELECT m.tenant_id,t.name AS tenant_name,t.status AS tenant_status,m.role
       FROM tenant_memberships m JOIN tenants t ON t.tenant_id=m.tenant_id
      WHERE m.platform_user_id=$1 AND m.status='active' AND t.status IN ('active','test')
      ORDER BY t.created_at,m.tenant_id`,
    [platformUserId]
  );
  return result.rows;
}

export async function createConsoleSession(platformUserId: string, selectedTenantId: string | null, provenance?: { impersonation_id: string; admin_id: string }): Promise<{ token: string; expires_in: number; session_id: string }> {
  const token = randomBytes(32).toString("hex");
  const inserted = await pool.query(
    `INSERT INTO console_sessions
      (token_hash,platform_user_id,selected_tenant_id,user_session_version,expires_at,impersonation_id,impersonated_by_admin_id)
     SELECT $1,u.platform_user_id,$2,u.session_version,NOW()+($3::text || ' seconds')::interval,$5,$6
       FROM platform_users u WHERE u.platform_user_id=$4 AND u.status='active'
     RETURNING session_id`,
    [tokenHash(token), selectedTenantId, SESSION_ABSOLUTE_SECONDS, platformUserId, provenance?.impersonation_id ?? null, provenance?.admin_id ?? null]
  );
  if (inserted.rowCount !== 1) throw new Error("Cannot issue a session for an inactive platform user");
  return { token, expires_in: SESSION_ABSOLUTE_SECONDS, session_id: inserted.rows[0].session_id };
}

export async function authenticateConsoleSession(request: IncomingMessage, allowUnselected = false): Promise<ConsoleSessionContext | undefined> {
  const token = bearerToken(request);
  if (!token) return undefined;
  const result = await pool.query<ConsoleSessionContext>(
    `SELECT s.session_id,u.platform_user_id,u.email,u.display_name,
            s.selected_tenant_id AS tenant_id,t.name AS tenant_name,t.status AS tenant_status,m.role,
            s.impersonation_id,s.impersonated_by_admin_id,pa.display_name AS impersonated_by_name,s.session_scope
       FROM console_sessions s
       JOIN platform_users u ON u.platform_user_id=s.platform_user_id
       LEFT JOIN tenants t ON t.tenant_id=s.selected_tenant_id
       LEFT JOIN tenant_memberships m ON m.tenant_id=s.selected_tenant_id AND m.platform_user_id=s.platform_user_id
       LEFT JOIN platform_admin_accounts pa ON pa.admin_id=s.impersonated_by_admin_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>NOW()
        AND s.last_seen_at>NOW()-($2::text || ' minutes')::interval
        AND u.status='active' AND u.session_version=s.user_session_version
        AND ((s.selected_tenant_id IS NULL AND $3::boolean)
             OR (s.selected_tenant_id IS NOT NULL AND t.status IN ('active','test') AND m.status='active'))`,
    [tokenHash(token), SESSION_IDLE_MINUTES, allowUnselected]
  );
  const session = result.rows[0];
  if (!session) {
    await pool.query(
      `UPDATE console_sessions SET revoked_at=NOW(),revoke_reason='identity_state_changed'
        WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>NOW()`,
      [tokenHash(token)]
    );
    return undefined;
  }
  await pool.query(`UPDATE console_sessions SET last_seen_at=NOW() WHERE session_id=$1`, [session.session_id]);
  return session;
}

async function createCopilotEmbedSession(platformUserId: string, tenantId: string): Promise<{ token: string; expires_in: number }> {
  const token = randomBytes(32).toString("hex");
  const expiresIn = 10 * 60;
  const inserted = await pool.query<{ session_id: string }>(
    `INSERT INTO console_sessions
      (token_hash,platform_user_id,selected_tenant_id,user_session_version,expires_at,session_scope)
     SELECT $1,u.platform_user_id,$2,u.session_version,NOW()+($3::text || ' seconds')::interval,'copilot_embed'
       FROM platform_users u WHERE u.platform_user_id=$4 AND u.status='active'
     RETURNING session_id`,
    [tokenHash(token), tenantId, expiresIn, platformUserId]
  );
  if (!inserted.rows[0]) throw new Error("Cannot issue Copilot embed session");
  return { token, expires_in: expiresIn };
}

async function exchangeChatwootEmbedSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse((await readBody(request)).toString("utf8"));
  } catch {
    return sendJson(response, 400, { error: { code: "invalid_request", message: "嵌入会话请求格式不正确" } });
  }
  const accountId = Number(input.account_id);
  const credentials = input.credentials && typeof input.credentials === "object" ? input.credentials as Record<string, unknown> : {};
  const accessToken = typeof credentials["access-token"] === "string" ? credentials["access-token"].trim() : "";
  const apiAccessToken = typeof credentials.api_access_token === "string" ? credentials.api_access_token.trim() : "";
  const client = typeof credentials.client === "string" ? credentials.client.trim() : "";
  const uid = typeof credentials.uid === "string" ? credentials.uid.trim().toLowerCase() : "";
  const expiry = typeof credentials.expiry === "string" ? credentials.expiry.trim() : "";
  const tokenType = typeof credentials["token-type"] === "string" ? credentials["token-type"].trim() : "Bearer";
  const browserSessionReady = accessToken && client && /^\S+@\S+\.\S+$/.test(uid);
  const apiSessionReady = apiAccessToken && apiAccessToken.length <= 512;
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || (!browserSessionReady && !apiSessionReady) ||
      accessToken.length > 512 || client.length > 512 || expiry.length > 32 || tokenType.length > 32) {
    return sendJson(response, 400, { error: { code: "invalid_chatwoot_session", message: "Chatwoot 登录凭据不完整" } });
  }
  const baseUrl = process.env.CHATWOOT_BASE_URL;
  if (!baseUrl) return sendJson(response, 503, { error: { code: "chatwoot_unavailable", message: "Chatwoot 尚未配置" } });
  let profileResponse: Response;
  try {
    const headers: Record<string, string> = apiSessionReady
      ? { api_access_token: apiAccessToken, "x-forwarded-proto": "https" }
      : { "access-token": accessToken, client, uid, expiry, "token-type": tokenType, "x-forwarded-proto": "https" };
    profileResponse = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/profile`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(7_000)
    });
  } catch {
    return sendJson(response, 503, { error: { code: "chatwoot_unavailable", message: "无法核验 Chatwoot 登录身份" } });
  }
  if (!profileResponse.ok) return sendJson(response, 401, { error: { code: "chatwoot_session_expired", message: "Chatwoot 登录已失效，请重新进入客服工作台" } });
  const profile = await profileResponse.json() as { id?: unknown; email?: unknown; accounts?: Array<{ id?: unknown; status?: unknown }> };
  const chatwootUserId = Number(profile.id);
  const email = typeof profile.email === "string" ? profile.email.trim().toLowerCase() : "";
  const accountAllowed = Array.isArray(profile.accounts) && profile.accounts.some(item => Number(item.id) === accountId && item.status !== "disabled");
  if (!Number.isSafeInteger(chatwootUserId) || chatwootUserId <= 0 || !email || !accountAllowed) {
    return sendJson(response, 403, { error: { code: "chatwoot_account_forbidden", message: "当前 Chatwoot 账号无权访问该企业" } });
  }
  const mapping = await pool.query<{ platform_user_id: string; tenant_id: string }>(
    `SELECT m.platform_user_id,m.tenant_id
       FROM tenant_memberships m JOIN platform_users u ON u.platform_user_id=m.platform_user_id
       JOIN tenants t ON t.tenant_id=m.tenant_id
      WHERE m.chatwoot_user_id=$1 AND LOWER(m.chatwoot_user_email)=$2 AND m.chatwoot_account_id=$3
        AND m.status='active' AND u.status='active' AND t.status IN ('active','test') AND t.chatwoot_account_id=m.chatwoot_account_id`,
    [chatwootUserId, email, accountId]
  );
  if (!mapping.rows[0]) return sendJson(response, 403, { error: { code: "membership_disabled", message: "当前成员未映射到可用企业工作区" } });
  const issued = await createCopilotEmbedSession(mapping.rows[0].platform_user_id, mapping.rows[0].tenant_id);
  await pool.query(
    `INSERT INTO audit_logs
      (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
     VALUES($1,'platform_user',$2,'session.copilot_embed_issued','chatwoot_account',$3,
            jsonb_build_object('expires_in',$4::int),$5)`,
    [mapping.rows[0].tenant_id, mapping.rows[0].platform_user_id, String(accountId), issued.expires_in, randomUUID()]
  );
  return sendJson(response, 200, { data: issued });
}

async function auditSession(session: ConsoleSessionContext, action: string, tenantId?: string | null): Promise<void> {
  const auditTenant = tenantId ?? session.tenant_id;
  if (!auditTenant) return;
  await pool.query(
    `INSERT INTO audit_logs
      (tenant_id,actor_type,actor_id,action,resource_type,resource_id,request_id)
     VALUES ($1,'platform_user',$2,$3,'console_session',$4,$5)`,
    [auditTenant, session.platform_user_id, action, session.session_id, randomUUID()]
  );
}

async function login(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let input: { email?: unknown; password?: unknown; captcha_token?: unknown };
  try {
    input = JSON.parse((await readBody(request)).toString("utf8"));
  } catch {
    return sendJson(response, 400, { error: { code: "invalid_request", message: "登录请求格式不正确" } });
  }
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!(await verifyCaptchaToken(input.captcha_token))) {
    return sendJson(response, 403, { error: { code: "captcha_required", message: "人机验证未通过或已失效" } });
  }
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 1 || password.length > 128) {
    return sendJson(response, 401, { error: { code: "invalid_credentials", message: "邮箱或密码错误" } });
  }
  const found = await pool.query<{
    platform_user_id: string; password_hash: string | null; failed_login_attempts: number; locked_until: Date | null;
  }>(`SELECT platform_user_id,password_hash,failed_login_attempts,locked_until FROM platform_users WHERE email=$1 AND status='active'`, [email]);
  const user = found.rows[0];
  const valid = await verifyConsolePassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!user || !valid || (user.locked_until && user.locked_until > new Date())) {
    if (user) {
      await pool.query(
        `UPDATE platform_users SET failed_login_attempts=failed_login_attempts+1,
          locked_until=CASE WHEN failed_login_attempts+1>=5 THEN NOW()+INTERVAL '15 minutes' ELSE locked_until END,
          updated_at=NOW() WHERE platform_user_id=$1`,
        [user.platform_user_id]
      );
      await recordSecurityLogin(request,user.platform_user_id,401);
    }
    return sendJson(response, 401, { error: { code: "invalid_credentials", message: "邮箱或密码错误" } });
  }
  const workspaces = await listWorkspaces(user.platform_user_id);
  if (!workspaces.length) return sendJson(response, 403, { error: { code: "no_active_workspace", message: "当前账号没有可用企业工作区" } });
  await pool.query(
    `UPDATE platform_users SET failed_login_attempts=0,locked_until=NULL,last_login_at=NOW(),updated_at=NOW()
      WHERE platform_user_id=$1`,
    [user.platform_user_id]
  );
  const selectedTenantId = workspaces.length === 1 ? workspaces[0].tenant_id : null;
  const issued = await createConsoleSession(user.platform_user_id, selectedTenantId);
  await recordSecurityLogin(request,user.platform_user_id,200);
  return sendJson(response, 200, { data: { ...issued, workspace_required: selectedTenantId === null } });
}

async function demoSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (process.env.CONSOLE_DEMO_LOGIN !== "true") return sendJson(response, 404, { error: { code: "not_found" } });
  const token = bearerToken(request);
  if (!token) return sendJson(response, 401, { error: { code: "unauthorized" } });
  const key = await pool.query<{ platform_user_id: string; tenant_id: string }>(
    `SELECT k.platform_user_id,k.tenant_id FROM tenant_api_keys k
      JOIN platform_users u ON u.platform_user_id=k.platform_user_id
      JOIN tenant_memberships m ON m.platform_user_id=k.platform_user_id AND m.tenant_id=k.tenant_id
      JOIN tenants t ON t.tenant_id=k.tenant_id
     WHERE k.key_hash=$1 AND k.status='active' AND u.status='active' AND m.status='active' AND t.status IN ('active','test')`,
    [tokenHash(token)]
  );
  if (!key.rows[0]) return sendJson(response, 401, { error: { code: "unauthorized" } });
  const issued = await createConsoleSession(key.rows[0].platform_user_id, key.rows[0].tenant_id);
  return sendJson(response, 200, { data: { ...issued, workspace_required: false } });
}

export async function handleConsoleAuthApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/v1/auth/")) return false;
  if (request.method === "POST" && url.pathname === "/api/v1/auth/login") {
    await login(request, response);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/auth/demo-session") {
    await demoSession(request, response);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/auth/chatwoot-embed-session") {
    await exchangeChatwootEmbedSession(request, response);
    return true;
  }
  const session = await authenticateConsoleSession(request, true);
  if (!session) {
    sendJson(response, 401, { error: { code: "session_expired", message: "登录已失效，请重新登录" } });
    return true;
  }
  if (session.session_scope === "copilot_embed") {
    sendJson(response, 403, { error: { code: "session_scope_forbidden", message: "Copilot 嵌入会话不能访问控制台身份接口" } });
    return true;
  }
  if(session.tenant_id)captureSecurityOperation(request,response,url,{tenant_id:session.tenant_id,platform_user_id:session.platform_user_id,actor_id:session.platform_user_id,role:session.role??'agent',auth_kind:'console_session',impersonation_id:session.impersonation_id,session_scope:session.session_scope},randomUUID());
  if (request.method === "GET" && url.pathname === "/api/v1/auth/session") {
    const workspaces = await listWorkspaces(session.platform_user_id);
    sendJson(response, 200, { data: { user: { id: session.platform_user_id, email: session.email, display_name: session.display_name }, selected_tenant_id: session.tenant_id, workspaces,
      impersonation: session.impersonation_id ? { id: session.impersonation_id, admin_name: session.impersonated_by_name } : null } });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/auth/select-workspace") {
    let tenantId = "";
    try {
      const input = JSON.parse((await readBody(request)).toString("utf8")) as { tenant_id?: unknown };
      tenantId = typeof input.tenant_id === "string" ? input.tenant_id : "";
    } catch {
      // handled as an invalid workspace below
    }
    const workspaces = await listWorkspaces(session.platform_user_id);
    if (!workspaces.some(item => item.tenant_id === tenantId)) {
      sendJson(response, 403, { error: { code: "workspace_forbidden", message: "无权访问该企业工作区" } });
      return true;
    }
    await pool.query(`UPDATE console_sessions SET selected_tenant_id=$1,last_seen_at=NOW() WHERE session_id=$2`, [tenantId, session.session_id]);
    await auditSession(session, "session.workspace_selected", tenantId);
    sendJson(response, 200, { data: { selected_tenant_id: tenantId } });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/auth/logout") {
    await pool.query(`UPDATE console_sessions SET revoked_at=NOW(),revoke_reason='user_logout' WHERE session_id=$1`, [session.session_id]);
    await auditSession(session, "session.logged_out");
    sendJson(response, 200, { data: { logged_out: true } });
    return true;
  }
  sendJson(response, 404, { error: { code: "not_found" } });
  return true;
}
