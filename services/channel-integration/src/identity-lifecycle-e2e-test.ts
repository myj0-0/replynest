import { createHash } from "node:crypto";
import { pool } from "./database.js";
import { requiredEnv } from "./shared.js";

const baseUrl = `http://127.0.0.1:${process.env.PORT ?? 3001}`;
const tenantId = requiredEnv("DEMO_TENANT_ID");
const demoApiKey = requiredEnv("DEMO_TENANT_API_KEY");
const suffix = Date.now();
const memberEmail = `phase44c-member-${suffix}@example.test`;
const mailEmail = `phase44c-mail-${suffix}@example.test`;
const inviteToken = createHash("sha256").update(`invite-${suffix}`).digest("hex");
const resetToken = createHash("sha256").update(`reset-${suffix}`).digest("hex");
const firstPassword = `Lifecycle-${suffix}-First!`;
const secondPassword = `Lifecycle-${suffix}-Second!`;
let memberId = "";

function tokenHash(value: string) { return createHash("sha256").update(value).digest("hex"); }
async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await response.json() as any;
  return { response, body };
}

const demoSession = await call("/api/v1/auth/demo-session", { method: "POST", headers: { authorization: `Bearer ${demoApiKey}` } });
const adminToken = String(demoSession.body.data?.token ?? "");
if (!/^[a-f0-9]{64}$/.test(adminToken)) throw new Error("Could not obtain the admin Console session");
const admin = await pool.query<{ platform_user_id:string; chatwoot_account_id:string }>(
  `SELECT m.platform_user_id,m.chatwoot_account_id FROM tenant_memberships m WHERE m.tenant_id=$1 AND m.status='active' AND m.role='tenant_admin' LIMIT 1`, [tenantId]
);
if (!admin.rows[0]) throw new Error("Demo administrator membership is missing");

try {
  const emailed = await call("/api/v1/members/invitations", { method: "POST", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ email: mailEmail, display_name: "Mail delivery fixture", role: "agent" }) });
  if (emailed.response.status !== 201) throw new Error(`Invitation email endpoint returned ${emailed.response.status}`);
  const mailpit = await fetch("http://mailpit:8025/api/v1/messages", { signal: AbortSignal.timeout(5_000) });
  if (!mailpit.ok || !(await mailpit.text()).includes(mailEmail)) throw new Error("Invitation was not observable in Mailpit");

  await pool.query(
    `INSERT INTO member_invitations(tenant_id,email,display_name,role,token_hash,invited_by,expires_at)
     VALUES ($1,$2,'Lifecycle fixture','agent',$3,$4,NOW()+INTERVAL '1 hour')`,
    [tenantId, memberEmail, tokenHash(inviteToken), admin.rows[0].platform_user_id]
  );
  const accepted = await call("/api/v1/auth/accept-invitation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: inviteToken, password: firstPassword }) });
  const memberToken = String(accepted.body.data?.token ?? "");
  if (accepted.response.status !== 200 || !/^[a-f0-9]{64}$/.test(memberToken)) throw new Error("Invitation acceptance did not create a Console session");
  const member = await pool.query<{ platform_user_id:string;chatwoot_sync_status:string }>(
    `SELECT m.platform_user_id,m.chatwoot_sync_status FROM tenant_memberships m JOIN platform_users u ON u.platform_user_id=m.platform_user_id WHERE m.tenant_id=$1 AND u.email=$2`, [tenantId, memberEmail]
  );
  memberId = member.rows[0]?.platform_user_id ?? "";
  if (!memberId || member.rows[0].chatwoot_sync_status !== "synced") throw new Error("Accepted member was not synchronized to Chatwoot");
  const replay = await call("/api/v1/auth/accept-invitation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: inviteToken, password: firstPassword }) });
  if (replay.response.status !== 410) throw new Error("Consumed invitation token was reusable");

  await pool.query(`INSERT INTO password_reset_tokens(platform_user_id,token_hash,expires_at) VALUES ($1,$2,NOW()+INTERVAL '30 minutes')`, [memberId, tokenHash(resetToken)]);
  const reset = await call("/api/v1/auth/reset-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: resetToken, password: secondPassword }) });
  if (reset.response.status !== 200) throw new Error("Password reset failed");
  const expiredSession = await call("/api/v1/auth/session", { headers: { authorization: `Bearer ${memberToken}` } });
  if (expiredSession.response.status !== 401) throw new Error("Password reset did not revoke old sessions");
  const newLogin = await call("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: memberEmail, password: secondPassword }) });
  if (newLogin.response.status !== 200) throw new Error("Reset password could not log in");

  const disabled = await call(`/api/v1/members/${memberId}`, { method: "PATCH", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ status: "disabled" }) });
  if (![200, 202].includes(disabled.response.status)) throw new Error("Member disable failed");
  const mapping = await pool.query<{ status:string;chatwoot_sync_status:string }>(`SELECT status,chatwoot_sync_status FROM tenant_memberships WHERE tenant_id=$1 AND platform_user_id=$2`, [tenantId, memberId]);
  if (mapping.rows[0]?.status !== "disabled" || mapping.rows[0]?.chatwoot_sync_status !== "synced") throw new Error("Member disable did not synchronize to Chatwoot");

  console.log("Phase 4.4.2c lifecycle E2E passed: Mailpit invite, one-time accept, Chatwoot provision, password reset, session revocation and deprovision");
} finally {
  await pool.query(`DELETE FROM member_invitations WHERE tenant_id=$1 AND email IN ($2,$3)`, [tenantId, memberEmail, mailEmail]);
  if (memberId) {
    await pool.query(`DELETE FROM password_reset_tokens WHERE platform_user_id=$1`, [memberId]);
    await pool.query(`DELETE FROM console_sessions WHERE platform_user_id=$1`, [memberId]);
    await pool.query(`DELETE FROM tenant_memberships WHERE tenant_id=$1 AND platform_user_id=$2`, [tenantId, memberId]);
    await pool.query(`DELETE FROM platform_users WHERE platform_user_id=$1`, [memberId]);
  }
  await pool.end();
}
