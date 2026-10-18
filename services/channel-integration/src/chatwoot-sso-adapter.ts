import { randomBytes } from "node:crypto";
import { requiredEnv, signature } from "./shared.js";

export type ChatwootSsoRequest = {
  email: string;
  account_id: number;
};

export type ChatwootSsoAdapterConfig = {
  internalBaseUrl: string;
  publicBaseUrl: string;
  sharedSecret: string;
  serviceAccessToken?: string;
};

export type ChatwootMemberRequest = {
  email: string;
  account_id: number;
  name?: string;
  role?: "administrator" | "agent";
};

export type ChatwootWorkspaceRequest = {
  workspace_key: string;
  company_name: string;
  email: string;
  name: string;
};

export function signedSsoExchangeRequest(
  body: ChatwootSsoRequest,
  sharedSecret: string,
  timestamp = String(Date.now()),
  nonce = randomBytes(16).toString("hex")
) {
  if (sharedSecret.length < 32) throw new Error("SAAS_SSO_SHARED_SECRET must contain at least 32 characters");
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    rawBody,
    headers: {
      "content-type": "application/json",
      "x-forwarded-proto": "https",
      "x-saas-timestamp": timestamp,
      "x-saas-nonce": nonce,
      "x-saas-signature": signature(sharedSecret, timestamp, nonce, rawBody)
    }
  };
}

async function signedPost(path: string, body: Record<string, unknown>, config: ChatwootSsoAdapterConfig, timeoutMs = 3_000) {
  const signed = signedSsoExchangeRequest(body as ChatwootSsoRequest, config.sharedSecret);
  const response = await fetch(`${config.internalBaseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: signed.headers,
    body: signed.rawBody,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Chatwoot adapter ${path} returned ${response.status}: ${raw.slice(0, 120)}`);
  return JSON.parse(raw) as Record<string, unknown>;
}

export async function issueChatwootSsoLink(body: ChatwootSsoRequest, config: ChatwootSsoAdapterConfig) {
  const result = await signedPost("/internal/saas_sso/exchange", body, config) as { login_url?: string; expires_in?: number };
  if (!result.login_url || result.expires_in !== 300) throw new Error("Chatwoot SSO exchange returned an invalid response");
  const loginUrl = new URL(result.login_url);
  const publicOrigin = new URL(config.publicBaseUrl).origin;
  if (loginUrl.origin !== publicOrigin || loginUrl.pathname !== "/app/login") {
    throw new Error("Chatwoot SSO exchange returned an unexpected login origin or path");
  }
  if (!loginUrl.searchParams.get("sso_auth_token") || !loginUrl.searchParams.get("sso_account_id")) {
    throw new Error("Chatwoot SSO exchange response is missing required one-time login parameters");
  }
  return { login_url: loginUrl.toString(), expires_in: result.expires_in };
}

export async function provisionChatwootMember(body: Required<ChatwootMemberRequest>, config: ChatwootSsoAdapterConfig) {
  const result = await signedPost("/internal/saas_sso/members/provision", body, config, 5_000);
  if (!Number.isInteger(result.user_id) || Number(result.account_id) !== body.account_id || result.email !== body.email || result.role !== body.role) {
    throw new Error("Chatwoot member provision returned an invalid response");
  }
  return { user_id: Number(result.user_id), email: String(result.email), account_id: Number(result.account_id), role: String(result.role) };
}

export async function deprovisionChatwootMember(body: Pick<ChatwootMemberRequest, "email" | "account_id">, config: ChatwootSsoAdapterConfig) {
  const result = await signedPost("/internal/saas_sso/members/deprovision", body, config, 5_000);
  if (result.removed !== true || Number(result.account_id) !== body.account_id) throw new Error("Chatwoot member deprovision returned an invalid response");
  return { removed: true };
}

export async function provisionChatwootWorkspace(body: ChatwootWorkspaceRequest, config: ChatwootSsoAdapterConfig) {
  // Resolve the server-owned service identity, never accept a tenant-supplied ID.
  const base = config.internalBaseUrl.replace(/\/$/, "");
  const headers = { api_access_token: config.serviceAccessToken ?? requiredEnv("CHATWOOT_API_ACCESS_TOKEN"), "x-forwarded-proto": "https" };
  const profileResponse = await fetch(`${base}/api/v1/profile`, { headers, redirect: "error", signal: AbortSignal.timeout(5_000) });
  if (!profileResponse.ok) throw new Error("Chatwoot service identity unavailable");
  const profile = await profileResponse.json() as {id?: number};
  if (!Number.isSafeInteger(profile.id) || Number(profile.id) <= 0) throw new Error("Chatwoot service identity invalid");
  const result = await signedPost("/internal/saas_sso/workspaces/provision", { ...body, gateway_service_user_id: profile.id }, config, 10_000);
  if (!Number.isInteger(result.account_id) || !Number.isInteger(result.user_id) || result.email !== body.email.toLowerCase() || result.workspace_key !== body.workspace_key) {
    throw new Error("Chatwoot workspace provision returned an invalid response");
  }
  if (result.gateway_service_user_id !== profile.id) throw new Error("Chatwoot workspace service membership was not confirmed");
  const access = await fetch(`${base}/api/v1/accounts/${result.account_id}/conversations?page=1&status=all`, { headers, redirect: "error", signal: AbortSignal.timeout(5_000) });
  await access.body?.cancel();
  if (!access.ok) throw new Error("Chatwoot workspace service access unavailable");
  return { account_id: Number(result.account_id), user_id: Number(result.user_id), email: String(result.email), workspace_key: String(result.workspace_key) };
}
