import { hashConsolePassword } from "./console-password.js";
import { pool } from "./database.js";
import { requiredEnv } from "./shared.js";

const baseUrl = `http://127.0.0.1:${process.env.PORT ?? 3001}`;
const tenantId = requiredEnv("DEMO_TENANT_ID");
const testPassword = `Synthetic-${Date.now()}-Password!`;

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
  const body = await response.json() as any;
  return { response, body };
}

const member = await pool.query<{ platform_user_id: string; email: string; password_hash: string | null }>(
  `SELECT u.platform_user_id,u.email,u.password_hash
     FROM platform_users u JOIN tenant_memberships m ON m.platform_user_id=u.platform_user_id
    WHERE m.tenant_id=$1 AND m.status='active' LIMIT 1`,
  [tenantId]
);
if (!member.rows[0]) throw new Error("Phase 4.4.2b requires the demo platform membership");
const original = member.rows[0];
const passwordHash = await hashConsolePassword(testPassword);
const createdSessionIds: string[] = [];

try {
  await pool.query(
    `UPDATE platform_users SET password_hash=$1,status='active',failed_login_attempts=0,locked_until=NULL WHERE platform_user_id=$2`,
    [passwordHash, original.platform_user_id]
  );

  const wrong = await request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: original.email, password: `${testPassword}-wrong` }) });
  if (wrong.response.status !== 401 || wrong.body.error?.code !== "invalid_credentials") throw new Error("Invalid login was not rejected");

  const login = await request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: original.email, password: testPassword }) });
  const token = String(login.body.data?.token ?? "");
  if (login.response.status !== 200 || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Valid login did not issue an opaque session");
  const sessionRow = await pool.query<{ session_id: string }>(`SELECT session_id FROM console_sessions WHERE token_hash=encode(digest($1,'sha256'),'hex')`, [token]);
  createdSessionIds.push(sessionRow.rows[0].session_id);

  const session = await request("/api/v1/auth/session", { headers: { authorization: `Bearer ${token}` } });
  if (session.response.status !== 200 || session.body.data?.selected_tenant_id !== tenantId) throw new Error("Session did not resolve the server-side workspace");

  const workbench = await request("/api/v1/session/chatwoot-link", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  if (workbench.response.status !== 200 || !workbench.body.data?.login_url) throw new Error("Console session could not obtain a Chatwoot ticket");

  await pool.query(`UPDATE tenant_memberships SET status='disabled',updated_at=NOW() WHERE tenant_id=$1 AND platform_user_id=$2`, [tenantId, original.platform_user_id]);
  const disabled = await request("/api/v1/auth/session", { headers: { authorization: `Bearer ${token}` } });
  if (disabled.response.status !== 401) throw new Error("Disabled membership did not invalidate the session");
  await pool.query(`UPDATE tenant_memberships SET status='active',updated_at=NOW() WHERE tenant_id=$1 AND platform_user_id=$2`, [tenantId, original.platform_user_id]);
  const replay = await request("/api/v1/auth/session", { headers: { authorization: `Bearer ${token}` } });
  if (replay.response.status !== 401) throw new Error("Invalidated session became usable after membership restoration");

  const secondLogin = await request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: original.email, password: testPassword }) });
  const secondToken = String(secondLogin.body.data?.token ?? "");
  const secondRow = await pool.query<{ session_id: string }>(`SELECT session_id FROM console_sessions WHERE token_hash=encode(digest($1,'sha256'),'hex')`, [secondToken]);
  createdSessionIds.push(secondRow.rows[0].session_id);
  const forbiddenWorkspace = await request("/api/v1/auth/select-workspace", { method: "POST", headers: { authorization: `Bearer ${secondToken}`, "content-type": "application/json" }, body: JSON.stringify({ tenant_id: "tenant-client-forgery" }) });
  if (forbiddenWorkspace.response.status !== 403) throw new Error("Client-forged workspace was not rejected");
  const logout = await request("/api/v1/auth/logout", { method: "POST", headers: { authorization: `Bearer ${secondToken}` } });
  if (logout.response.status !== 200) throw new Error("Logout failed");
  const loggedOut = await request("/api/v1/auth/session", { headers: { authorization: `Bearer ${secondToken}` } });
  if (loggedOut.response.status !== 401) throw new Error("Logged-out session remained valid");

  console.log("Phase 4.4.2b auth E2E passed: login, workspace binding, member invalidation, ticket broker and logout");
} finally {
  await pool.query(`UPDATE tenant_memberships SET status='active',updated_at=NOW() WHERE tenant_id=$1 AND platform_user_id=$2`, [tenantId, original.platform_user_id]);
  await pool.query(`UPDATE platform_users SET password_hash=$1,failed_login_attempts=0,locked_until=NULL WHERE platform_user_id=$2`, [original.password_hash, original.platform_user_id]);
  if (createdSessionIds.length) await pool.query(`UPDATE console_sessions SET revoked_at=COALESCE(revoked_at,NOW()),revoke_reason=COALESCE(revoke_reason,'test_cleanup') WHERE session_id=ANY($1::uuid[])`, [createdSessionIds]);
  await pool.end();
}
