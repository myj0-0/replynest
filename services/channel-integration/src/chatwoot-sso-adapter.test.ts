import assert from "node:assert/strict";
import test from "node:test";
import { issueChatwootSsoLink, provisionChatwootMember, provisionChatwootWorkspace, signedSsoExchangeRequest } from "./chatwoot-sso-adapter.js";
import { signature } from "./shared.js";

test("SSO exchange signs the exact timestamp, nonce and raw JSON body", () => {
  const body = { email: "agent@example.test", account_id: 2 };
  const request = signedSsoExchangeRequest(body, "s".repeat(32), "1724328000000", "a".repeat(32));
  assert.equal(request.headers["x-saas-signature"], signature("s".repeat(32), "1724328000000", "a".repeat(32), request.rawBody));
  assert.deepEqual(JSON.parse(request.rawBody.toString("utf8")), body);
});

test("SSO exchange rejects short shared secrets", () => {
  assert.throws(() => signedSsoExchangeRequest({ email: "a@example.test", account_id: 2 }, "short"), /at least 32/);
});

test("SSO adapter accepts only the configured public Chatwoot login origin", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    login_url: "http://localhost:3000/app/login?email=a%40example.test&sso_auth_token=once&sso_account_id=2",
    expires_in: 300
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const result = await issueChatwootSsoLink(
      { email: "a@example.test", account_id: 2 },
      { internalBaseUrl: "http://rails:3000", publicBaseUrl: "http://localhost:3000", sharedSecret: "s".repeat(32) }
    );
    assert.equal(new URL(result.login_url).origin, "http://localhost:3000");
    assert.equal(result.expires_in, 300);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SSO adapter rejects a login URL from another origin", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    login_url: "https://attacker.invalid/app/login?sso_auth_token=once&sso_account_id=2",
    expires_in: 300
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(
      issueChatwootSsoLink(
        { email: "a@example.test", account_id: 2 },
        { internalBaseUrl: "http://rails:3000", publicBaseUrl: "http://localhost:3000", sharedSecret: "s".repeat(32) }
      ),
      /unexpected login origin/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("member provision validates the Chatwoot identity mapping response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ user_id: 42, email: "agent@example.test", account_id: 2, role: "agent" }), { status: 200 });
  try {
    const result = await provisionChatwootMember(
      { email: "agent@example.test", name: "Agent", account_id: 2, role: "agent" },
      { internalBaseUrl: "http://rails:3000", publicBaseUrl: "http://localhost:3000", sharedSecret: "s".repeat(32) }
    );
    assert.equal(result.user_id, 42);
  } finally { globalThis.fetch = originalFetch; }
});

test("workspace provision requires the stable ReplyNest workspace mapping", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith('/profile')) return Response.json({id: 1});
    if (String(url).includes('/conversations?')) return Response.json({data: {payload: []}});
    const body = JSON.parse(String(init?.body));
    assert.equal(body.gateway_service_user_id, 1);
    assert.equal(body.serviceAccessToken, undefined);
    return Response.json({ account_id: 71, user_id: 72, email: "owner@example.test", workspace_key: body.workspace_key, gateway_service_user_id: 1 });
  };
  try {
    const result = await provisionChatwootWorkspace(
      { workspace_key: "rn-00000000-0000-4000-8000-000000000001", company_name: "Example", email: "owner@example.test", name: "Owner" },
      { internalBaseUrl: "http://rails:3000", publicBaseUrl: "http://localhost:3000", sharedSecret: "s".repeat(32), serviceAccessToken: "test-only" }
    );
    assert.equal(result.account_id, 71);
    assert.equal(result.user_id, 72);
    assert.equal(calls.length, 3);
    assert.match(calls[2], /accounts\/71\/conversations/);
  } finally { globalThis.fetch = originalFetch; }
});

for (const scenario of ['profile_denied', 'invalid_identity', 'unconfirmed_membership', 'access_denied', 'wrong_workspace']) {
  test(`workspace provision fails closed: ${scenario}`, async () => {
    const originalFetch = globalThis.fetch;
    let provisions = 0;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/profile')) return Response.json({id: scenario === 'invalid_identity' ? 0 : 1}, {status: scenario === 'profile_denied' ? 401 : 200});
      if (String(url).includes('/conversations?')) return Response.json({}, {status: 401});
      provisions++;
      return Response.json({account_id: 71, user_id: 72, email: 'owner@example.test', workspace_key: scenario === 'wrong_workspace' ? 'another-tenant' : 'rn-test', gateway_service_user_id: scenario === 'unconfirmed_membership' ? undefined : 1});
    };
    try {
      await assert.rejects(provisionChatwootWorkspace({workspace_key: 'rn-test', company_name: 'Test', email: 'owner@example.test', name: 'Owner'},
        {internalBaseUrl: 'http://rails:3000', publicBaseUrl: 'http://localhost:3000', sharedSecret: 's'.repeat(32), serviceAccessToken: 'test-only'}));
      assert.equal(provisions, ['profile_denied', 'invalid_identity'].includes(scenario) ? 0 : 1);
    } finally {globalThis.fetch = originalFetch;}
  });
}
