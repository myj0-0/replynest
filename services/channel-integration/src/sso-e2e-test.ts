import assert from "node:assert/strict";
import { pool } from "./database.js";
import { signedSsoExchangeRequest } from "./chatwoot-sso-adapter.js";
import { requiredEnv } from "./shared.js";

const internalBaseUrl = requiredEnv("CHATWOOT_BASE_URL").replace(/\/$/, "");
const sharedSecret = requiredEnv("SAAS_SSO_SHARED_SECRET");
const apiKey = requiredEnv("DEMO_TENANT_API_KEY");
const tenantId = requiredEnv("DEMO_TENANT_ID");
const membership = await pool.query<{ chatwoot_user_email: string; chatwoot_account_id: string }>(
  `SELECT chatwoot_user_email,chatwoot_account_id FROM tenant_memberships
    WHERE tenant_id=$1 AND status='active' ORDER BY created_at LIMIT 1`,
  [tenantId]
);
assert.ok(membership.rows[0], "demo Chatwoot membership mapping is missing");

async function loginOnceAndCleanup(loginUrl: string) {
  const parsed = new URL(loginUrl);
  const email = parsed.searchParams.get("email");
  const token = parsed.searchParams.get("sso_auth_token");
  assert.ok(email && token, "one-time login URL is missing credentials");
  const payload = JSON.stringify({ email, sso_auth_token: token });
  const first = await fetch(`${internalBaseUrl}/auth/sign_in`, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
  assert.equal(first.status, 200, "first one-time login must succeed");
  const second = await fetch(`${internalBaseUrl}/auth/sign_in`, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
  assert.equal(second.status, 401, "the same one-time token must not be reusable");
  const logout = await fetch(`${internalBaseUrl}/auth/sign_out`, {
    method: "DELETE",
    headers: {
      "access-token": first.headers.get("access-token") ?? "",
      client: first.headers.get("client") ?? "",
      uid: first.headers.get("uid") ?? ""
    }
  });
  assert.ok([200, 404].includes(logout.status), `cleanup logout returned ${logout.status}`);
}

const brokerResponse = await fetch("http://localhost:3001/api/v1/session/chatwoot-link", {
  method: "POST",
  headers: { authorization: `Bearer ${apiKey}` }
});
assert.equal(brokerResponse.status, 200, "Gateway broker must issue a ticket for the mapped member");
const brokerBody = await brokerResponse.json() as { data: { login_url: string; expires_in: number } };
assert.equal(brokerBody.data.expires_in, 300);
await loginOnceAndCleanup(brokerBody.data.login_url);

const exchangeBody = {
  email: membership.rows[0].chatwoot_user_email,
  account_id: Number(membership.rows[0].chatwoot_account_id)
};
const signed = signedSsoExchangeRequest(exchangeBody, sharedSecret);
const directFirst = await fetch(`${internalBaseUrl}/internal/saas_sso/exchange`, { method: "POST", headers: signed.headers, body: signed.rawBody });
assert.equal(directFirst.status, 200, "a valid signed exchange must succeed");
const directBody = await directFirst.json() as { login_url: string };
const replay = await fetch(`${internalBaseUrl}/internal/saas_sso/exchange`, { method: "POST", headers: signed.headers, body: signed.rawBody });
assert.equal(replay.status, 409, "the same signed request nonce must be rejected");
await loginOnceAndCleanup(directBody.login_url);

const wrongAccount = signedSsoExchangeRequest({ ...exchangeBody, account_id: 999_999 }, sharedSecret);
const wrongAccountResponse = await fetch(`${internalBaseUrl}/internal/saas_sso/exchange`, {
  method: "POST",
  headers: wrongAccount.headers,
  body: wrongAccount.rawBody
});
assert.equal(wrongAccountResponse.status, 404, "a user without membership in the requested account must be rejected");

console.log("Phase 4.4 SSO E2E passed: broker mapping, membership, replay prevention, one-time use and cleanup");
await pool.end();
