import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticateConsoleSession, createConsoleSession } from "./console-auth.js";
import { hasPermission } from "./access-control.js";
import { assertCapacity, effectiveEntitlement, EntitlementLimitError } from "./subscriptions.js";
import { hashConsolePassword } from "./console-password.js";
import { deprovisionChatwootMember, provisionChatwootMember, type ChatwootSsoAdapterConfig } from "./chatwoot-sso-adapter.js";
import { pool } from "./database.js";
import { sendMail } from "./mail-provider.js";
import { readBody, requiredEnv, sendJson } from "./shared.js";
import { verifyCaptchaToken } from "./captcha.js";
import {recordSecurityLogin} from './tenant-security.js';

type LifecycleAuth = {
  tenant_id: string;
  tenant_name: string;
  role: "tenant_admin" | "supervisor" | "agent";
  platform_user_id: string | null;
};

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;
const ROLES = new Set(["tenant_admin", "supervisor", "agent"]);

function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function chatwootRole(role: string): "administrator" | "agent" { return role === "tenant_admin" ? "administrator" : "agent"; }
function adapterConfig(): ChatwootSsoAdapterConfig {
  return { internalBaseUrl: requiredEnv("CHATWOOT_BASE_URL"), publicBaseUrl: requiredEnv("CHATWOOT_PUBLIC_URL"), sharedSecret: requiredEnv("SAAS_SSO_SHARED_SECRET") };
}
function publicLink(path: string, token: string): string {
  const url = new URL(path, `${requiredEnv("CONSOLE_PUBLIC_ORIGIN").replace(/\/$/, "")}/`);
  url.searchParams.set("token", token);
  return url.toString();
}
async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  try { return JSON.parse((await readBody(request)).toString("utf8")) as Record<string, unknown>; }
  catch { return {}; }
}

export async function handlePublicIdentityLifecycleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (request.method === "POST" && url.pathname === "/api/v1/auth/forgot-password") {
    const input = await jsonBody(request);
    if (!(await verifyCaptchaToken(input.captcha_token))) { sendJson(response, 403, { error: { code: "captcha_required" } }); return true; }
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    if (EMAIL_PATTERN.test(email)) {
      const user = await pool.query<{ platform_user_id: string }>(`SELECT platform_user_id FROM platform_users WHERE email=$1 AND status='active'`, [email]);
      if (user.rows[0]) {
        const recent = await pool.query(`SELECT 1 FROM password_reset_tokens WHERE platform_user_id=$1 AND created_at>NOW()-INTERVAL '2 minutes' LIMIT 1`, [user.rows[0].platform_user_id]);
        if (!recent.rowCount) {
          const token = randomBytes(32).toString("hex");
          const inserted = await pool.query<{ reset_id: string }>(
            `INSERT INTO password_reset_tokens(platform_user_id,token_hash,expires_at)
             VALUES ($1,$2,NOW()+INTERVAL '30 minutes') RETURNING reset_id`,
            [user.rows[0].platform_user_id, hashToken(token)]
          );
          try {
            await sendMail({ to: email, subject: "重置智能客服助手密码", text: `请在 30 分钟内打开以下链接重置密码：\n\n${publicLink("/reset-password", token)}\n\n如果不是您本人操作，请忽略本邮件。` });
          } catch (error) {
            await pool.query(`UPDATE password_reset_tokens SET used_at=NOW() WHERE reset_id=$1`, [inserted.rows[0].reset_id]);
            console.warn("Password reset email delivery failed", error instanceof Error ? error.message : String(error));
          }
        }
      }
    }
    sendJson(response, 202, { data: { accepted: true, message: "如果该邮箱存在，重置邮件将很快送达" } });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/auth/reset-password") {
    const input = await jsonBody(request);
    const token = typeof input.token === "string" ? input.token : "";
    const password = typeof input.password === "string" ? input.password : "";
    if (!/^[a-f0-9]{64}$/i.test(token)) { sendJson(response, 400, { error: { code: "invalid_reset_token" } }); return true; }
    let passwordHash: string;
    try { passwordHash = await hashConsolePassword(password); }
    catch { sendJson(response, 400, { error: { code: "invalid_password", message: "密码必须为 12–128 位" } }); return true; }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const reset = await client.query<{ reset_id: string; platform_user_id: string }>(
        `SELECT reset_id,platform_user_id FROM password_reset_tokens
          WHERE token_hash=$1 AND used_at IS NULL AND expires_at>NOW() FOR UPDATE`, [hashToken(token)]
      );
      if (!reset.rows[0]) { await client.query("ROLLBACK"); sendJson(response, 410, { error: { code: "reset_token_expired" } }); return true; }
      await client.query(`UPDATE platform_users SET password_hash=$1,session_version=session_version+1,failed_login_attempts=0,locked_until=NULL,updated_at=NOW() WHERE platform_user_id=$2 AND status='active'`, [passwordHash, reset.rows[0].platform_user_id]);
      await client.query(`UPDATE password_reset_tokens SET used_at=NOW() WHERE platform_user_id=$1 AND used_at IS NULL`, [reset.rows[0].platform_user_id]);
      await client.query(`UPDATE console_sessions SET revoked_at=COALESCE(revoked_at,NOW()),revoke_reason=COALESCE(revoke_reason,'password_reset') WHERE platform_user_id=$1`, [reset.rows[0].platform_user_id]);
      await client.query(
        `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,request_id)
         SELECT m.tenant_id,'platform_user',$1::text,'identity.password_reset','platform_user',$1::text,$2
           FROM tenant_memberships m WHERE m.platform_user_id=$1::uuid`, [reset.rows[0].platform_user_id, randomUUID()]
      );
      await client.query("COMMIT");
      await recordSecurityLogin(request,reset.rows[0].platform_user_id,200,url.pathname,'identity.password_reset');
      sendJson(response, 200, { data: { reset: true } });
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/auth/accept-invitation") {
    const input = await jsonBody(request);
    const token = typeof input.token === "string" ? input.token : "";
    const password = typeof input.password === "string" ? input.password : "";
    if (!/^[a-f0-9]{64}$/i.test(token)) { sendJson(response, 400, { error: { code: "invalid_invitation" } }); return true; }
    const currentSession = await authenticateConsoleSession(request, true);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const invitation = await client.query<{
        invitation_id: string; tenant_id: string; email: string; display_name: string; role: "tenant_admin" | "supervisor" | "agent"; chatwoot_account_id: string;
      }>(`SELECT i.invitation_id,i.tenant_id,i.email,i.display_name,i.role,t.chatwoot_account_id
            FROM member_invitations i JOIN tenants t ON t.tenant_id=i.tenant_id
           WHERE i.token_hash=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>NOW()
             AND t.status IN ('active','test') FOR UPDATE`, [hashToken(token)]);
      const invite = invitation.rows[0];
      if (!invite) { await client.query("ROLLBACK"); sendJson(response, 410, { error: { code: "invitation_expired" } }); return true; }
      const existing = await client.query<{ platform_user_id: string; password_hash: string | null }>(`SELECT platform_user_id,password_hash FROM platform_users WHERE email=$1 FOR UPDATE`, [invite.email]);
      let passwordHash = existing.rows[0]?.password_hash ?? null;
      if (passwordHash && (currentSession?.platform_user_id !== existing.rows[0].platform_user_id || currentSession.email !== invite.email)) {
        await client.query("ROLLBACK"); sendJson(response, 409, { error: { code: "existing_user_login_required" } }); return true;
      }
      if (!passwordHash) {
        try { passwordHash = await hashConsolePassword(password); }
        catch { await client.query("ROLLBACK"); sendJson(response, 400, { error: { code: "invalid_password", message: "密码必须为 12–128 位" } }); return true; }
      }
      const provisioned = await provisionChatwootMember({ email: invite.email, name: invite.display_name, account_id: Number(invite.chatwoot_account_id), role: chatwootRole(invite.role) }, adapterConfig());
      const user = await client.query<{ platform_user_id: string }>(
        `INSERT INTO platform_users(email,display_name,password_hash,status,email_verified_at)
         VALUES ($1,$2,$3,'active',NOW())
         ON CONFLICT(email) DO UPDATE SET display_name=EXCLUDED.display_name,password_hash=EXCLUDED.password_hash,
           status='active',email_verified_at=COALESCE(platform_users.email_verified_at,NOW()),updated_at=NOW()
         RETURNING platform_user_id`, [invite.email, invite.display_name, passwordHash]
      );
      await client.query(
        `INSERT INTO tenant_memberships(tenant_id,platform_user_id,role,status,chatwoot_user_id,chatwoot_user_email,chatwoot_account_id,chatwoot_sync_status,chatwoot_synced_at)
         VALUES ($1,$2,$3,'active',$4,$5,$6,'synced',NOW())
         ON CONFLICT(tenant_id,platform_user_id) DO UPDATE SET role=EXCLUDED.role,status='active',chatwoot_user_id=EXCLUDED.chatwoot_user_id,
           chatwoot_user_email=EXCLUDED.chatwoot_user_email,chatwoot_account_id=EXCLUDED.chatwoot_account_id,chatwoot_sync_status='synced',chatwoot_sync_error=NULL,chatwoot_synced_at=NOW(),updated_at=NOW()`,
        [invite.tenant_id, user.rows[0].platform_user_id, invite.role, provisioned.user_id, invite.email, invite.chatwoot_account_id]
      );
      await client.query(`UPDATE member_invitations SET accepted_at=NOW() WHERE invitation_id=$1`, [invite.invitation_id]);
      await client.query(
        `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,request_id)
         VALUES ($1,'platform_user',$2,'member.invitation_accepted','tenant_membership',$2,$3)`,
        [invite.tenant_id, user.rows[0].platform_user_id, randomUUID()]
      );
      await client.query("COMMIT");
      const session = await createConsoleSession(user.rows[0].platform_user_id, invite.tenant_id);
      await recordSecurityLogin(request,user.rows[0].platform_user_id,200,url.pathname,'member.invitation_accepted');
      sendJson(response, 200, { data: { ...session, accepted: true } });
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    return true;
  }
  return false;
}

export async function handleMemberLifecycleApi(request: IncomingMessage, response: ServerResponse, url: URL, auth: LifecycleAuth, requestId: string): Promise<boolean> {
  if (!url.pathname.startsWith("/api/v1/members")) return false;
  const permission = request.method === "GET" ? "tenant.members.read" : "tenant.members.manage";
  if (!auth.platform_user_id || !hasPermission({ domain: "tenant", role: auth.role }, permission)) { sendJson(response, 403, { request_id: requestId, error: { code: "forbidden" } }); return true; }
  if (request.method === "GET" && url.pathname === "/api/v1/members") {
    const members = await pool.query(
      `SELECT m.platform_user_id,u.email,u.display_name,m.role,m.status,m.chatwoot_sync_status,m.chatwoot_sync_error,m.updated_at
         FROM tenant_memberships m JOIN platform_users u ON u.platform_user_id=m.platform_user_id
        WHERE m.tenant_id=$1 ORDER BY m.created_at`, [auth.tenant_id]
    );
    const invitations = await pool.query(
      `SELECT invitation_id,email,display_name,role,expires_at,created_at
         FROM member_invitations WHERE tenant_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>NOW()
        ORDER BY created_at DESC`, [auth.tenant_id]
    );
    const entitlement = await effectiveEntitlement(auth.tenant_id);
    const activeSeats = members.rows.filter(member => member.status === "active").length;
    sendJson(response, 200, { request_id: requestId, data: { members: members.rows, invitations: invitations.rows,
      capacity: { limit: entitlement.entitlements.seat_limit, active: activeSeats, pending: invitations.rows.length } } });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/members/invitations") {
    const input = await jsonBody(request);
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const displayName = typeof input.display_name === "string" ? input.display_name.trim().slice(0, 200) : "";
    const role = typeof input.role === "string" ? input.role : "";
    if (!EMAIL_PATTERN.test(email) || !displayName || !ROLES.has(role)) { sendJson(response, 400, { request_id: requestId, error: { code: "invalid_invitation" } }); return true; }
    const existing = await pool.query(`SELECT 1 FROM tenant_memberships m JOIN platform_users u ON u.platform_user_id=m.platform_user_id WHERE m.tenant_id=$1 AND u.email=$2 AND m.status='active'`, [auth.tenant_id, email]);
    if (existing.rowCount) { sendJson(response, 409, { request_id: requestId, error: { code: "member_exists" } }); return true; }
    const token = randomBytes(32).toString("hex");
    const client = await pool.connect();
    let invitationId = "";
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`member-capacity:${auth.tenant_id}`]);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`invite:${auth.tenant_id}:${email}`]);
      await client.query(`UPDATE member_invitations SET revoked_at=NOW() WHERE tenant_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL`, [auth.tenant_id, email]);
      const capacity=await client.query<{count:number}>(`SELECT (SELECT COUNT(*) FROM tenant_memberships WHERE tenant_id=$1 AND status='active')::int+(SELECT COUNT(*) FROM member_invitations WHERE tenant_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>NOW())::int AS count`,[auth.tenant_id]);
      await assertCapacity(auth.tenant_id,"seat_limit",capacity.rows[0].count,1,client);
      const invitation = await client.query<{ invitation_id: string }>(
        `INSERT INTO member_invitations(tenant_id,email,display_name,role,token_hash,invited_by,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '48 hours') RETURNING invitation_id`,
        [auth.tenant_id, email, displayName, role, hashToken(token), auth.platform_user_id]
      );
      invitationId = invitation.rows[0].invitation_id;
      await client.query(
        `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
         VALUES ($1,'platform_user',$2,'member.invited','member_invitation',$3,jsonb_build_object('email',$4::text,'role',$5::text),$6)`,
        [auth.tenant_id, auth.platform_user_id, invitationId, email, role, requestId]
      );
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK");if(error instanceof EntitlementLimitError){sendJson(response,409,{request_id:requestId,error:{code:"entitlement_limit_reached",metric:error.metric,limit:error.limit,used:error.used}});return true}throw error; }
    finally { client.release(); }
    try {
      await sendMail({ to: email, subject: `加入${auth.tenant_name}的智能客服工作区`, text: `您已被邀请加入“${auth.tenant_name}”。请在 48 小时内打开以下一次性链接：\n\n${publicLink("/invite", token)}\n\n链接使用后立即失效。` });
    } catch (error) {
      await pool.query(`UPDATE member_invitations SET revoked_at=NOW() WHERE invitation_id=$1`, [invitationId]);
      console.warn("Invitation email delivery failed", error instanceof Error ? error.message : String(error));
      sendJson(response, 503, { request_id: requestId, error: { code: "invitation_delivery_failed" } });
      return true;
    }
    sendJson(response, 201, { request_id: requestId, data: { invitation_id: invitationId, expires_in: 172800 } });
    return true;
  }
  const revokeMatch = url.pathname.match(/^\/api\/v1\/members\/invitations\/([0-9a-f-]{36})\/revoke$/i);
  if (revokeMatch && request.method === "POST") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`member-capacity:${auth.tenant_id}`]);
      // Tenant-scoped and conditional: an accepted invite cannot disable its member.
      const revoked = await client.query(
        `UPDATE member_invitations SET revoked_at=NOW()
          WHERE tenant_id=$1 AND invitation_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL
          RETURNING invitation_id`, [auth.tenant_id, revokeMatch[1]]
      );
      if (!revoked.rowCount) {
        await client.query("ROLLBACK");
        sendJson(response, 409, { request_id: requestId, error: { code: "invitation_not_pending" } });
        return true;
      }
      await client.query(
        `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,request_id)
         VALUES ($1,'platform_user',$2,'member.invitation_revoked','member_invitation',$3,$4)`,
        [auth.tenant_id, auth.platform_user_id, revokeMatch[1], requestId]
      );
      await client.query("COMMIT");
      sendJson(response, 200, { request_id: requestId, data: { revoked: true } });
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    return true;
  }
  const match = url.pathname.match(/^\/api\/v1\/members\/([0-9a-f-]{36})$/i);
  if (match && request.method === "PATCH") {
    if (match[1] === auth.platform_user_id) { sendJson(response, 409, { request_id: requestId, error: { code: "cannot_modify_self" } }); return true; }
    const input = await jsonBody(request);
    const nextStatus = typeof input.status === "string" ? input.status : undefined;
    const nextRole = typeof input.role === "string" ? input.role : undefined;
    if ((!nextStatus && !nextRole) || (nextStatus && !["active", "disabled"].includes(nextStatus)) || (nextRole && !ROLES.has(nextRole))) { sendJson(response, 400, { request_id: requestId, error: { code: "invalid_member_update" } }); return true; }
    const member = await pool.query<{ email: string; display_name: string; role: string; status: string; chatwoot_account_id: string }>(
      `SELECT u.email,u.display_name,m.role,m.status,m.chatwoot_account_id FROM tenant_memberships m JOIN platform_users u ON u.platform_user_id=m.platform_user_id WHERE m.tenant_id=$1 AND m.platform_user_id=$2`,
      [auth.tenant_id, match[1]]
    );
    if (!member.rows[0]) { sendJson(response, 404, { request_id: requestId, error: { code: "member_not_found" } }); return true; }
    const target = member.rows[0];
    const role = nextRole ?? target.role;
    const status = nextStatus ?? target.status;
    if(target.status!=="active"&&status==="active"){const active=await pool.query<{count:number}>(`SELECT COUNT(*)::int AS count FROM tenant_memberships WHERE tenant_id=$1 AND status='active'`,[auth.tenant_id]);try{await assertCapacity(auth.tenant_id,"seat_limit",active.rows[0].count)}catch(error){if(error instanceof EntitlementLimitError){sendJson(response,409,{request_id:requestId,error:{code:"entitlement_limit_reached",metric:error.metric,limit:error.limit,used:error.used}});return true}throw error}}
    if (status === "disabled") {
      await pool.query(`UPDATE tenant_memberships SET role=$3,status='disabled',chatwoot_sync_status='pending',chatwoot_sync_error=NULL,updated_at=NOW() WHERE tenant_id=$1 AND platform_user_id=$2`, [auth.tenant_id, match[1], role]);
      await pool.query(`UPDATE console_sessions SET revoked_at=COALESCE(revoked_at,NOW()),revoke_reason=COALESCE(revoke_reason,'membership_disabled') WHERE platform_user_id=$1 AND selected_tenant_id=$2`, [match[1], auth.tenant_id]);
      try {
        await deprovisionChatwootMember({ email: target.email, account_id: Number(target.chatwoot_account_id) }, adapterConfig());
        await pool.query(`UPDATE tenant_memberships SET chatwoot_sync_status='synced',chatwoot_sync_error=NULL,chatwoot_synced_at=NOW() WHERE tenant_id=$1 AND platform_user_id=$2`, [auth.tenant_id, match[1]]);
      } catch (error) {
        await pool.query(`UPDATE tenant_memberships SET chatwoot_sync_status='failed',chatwoot_sync_error=$3 WHERE tenant_id=$1 AND platform_user_id=$2`, [auth.tenant_id, match[1], (error instanceof Error ? error.message : String(error)).slice(0, 500)]);
      }
    } else {
      try {
        const provisioned = await provisionChatwootMember({ email: target.email, name: target.display_name, account_id: Number(target.chatwoot_account_id), role: chatwootRole(role) }, adapterConfig());
        await pool.query(`UPDATE tenant_memberships SET role=$3,status='active',chatwoot_user_id=$4,chatwoot_sync_status='synced',chatwoot_sync_error=NULL,chatwoot_synced_at=NOW(),updated_at=NOW() WHERE tenant_id=$1 AND platform_user_id=$2`, [auth.tenant_id, match[1], role, provisioned.user_id]);
      } catch (error) {
        await pool.query(`UPDATE tenant_memberships SET role=$3,chatwoot_sync_status='failed',chatwoot_sync_error=$4,updated_at=NOW() WHERE tenant_id=$1 AND platform_user_id=$2`, [auth.tenant_id, match[1], role, (error instanceof Error ? error.message : String(error)).slice(0, 500)]);
        sendJson(response, 503, { request_id: requestId, error: { code: "chatwoot_member_sync_failed" } });
        return true;
      }
    }
    await pool.query(
      `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
       VALUES ($1,'platform_user',$2,'member.updated','tenant_membership',$3,jsonb_build_object('role',$4::text,'status',$5::text),$6)`,
      [auth.tenant_id, auth.platform_user_id, match[1], role, status, requestId]
    );
    const updated = await pool.query(`SELECT role,status,chatwoot_sync_status,chatwoot_sync_error FROM tenant_memberships WHERE tenant_id=$1 AND platform_user_id=$2`, [auth.tenant_id, match[1]]);
    sendJson(response, updated.rows[0].chatwoot_sync_status === "synced" ? 200 : 202, { request_id: requestId, data: updated.rows[0] });
    return true;
  }
  sendJson(response, 404, { request_id: requestId, error: { code: "not_found" } });
  return true;
}
