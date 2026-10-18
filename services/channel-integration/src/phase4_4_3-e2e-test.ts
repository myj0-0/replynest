import { pool } from "./database.js";
import { requiredEnv } from "./shared.js";
import { issuePhoneVerification, verifyPhoneChallenge } from "./phone-verification.js";

const baseUrl = `http://127.0.0.1:${process.env.PORT ?? 3001}`;
const demoApiKey = requiredEnv("DEMO_TENANT_API_KEY");

async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
  const body = await response.json() as any;
  return { response, body };
}

const session = await call("/api/v1/auth/demo-session", { method: "POST", headers: { authorization: `Bearer ${demoApiKey}` } });
const token = String(session.body.data?.token ?? "");
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Could not obtain the admin Console session");

try {
  const diagnostics = await call("/api/v1/integrations/communications/diagnostics", { headers: { authorization: `Bearer ${token}` } });
  if (diagnostics.response.status !== 403 || diagnostics.body.error?.code !== "platform_diagnostics_restricted") throw new Error("Platform diagnostics must reject tenant administrators");
  if (diagnostics.body.data !== undefined) throw new Error("Platform diagnostics leaked tenant-visible configuration");

  const validated = await call("/api/v1/channels/wechat-official-account/synthetic-validate", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  if (validated.response.status !== 200 || validated.body.data?.status !== "ready" || validated.body.data?.mode !== "synthetic") throw new Error("Synthetic WeChat validation did not complete");
  const channels = await call("/api/v1/channels", { headers: { authorization: `Bearer ${token}` } });
  const wechat = channels.body.data?.find((item: any) => item.channel_type === "wechat_official_account");
  if (channels.response.status !== 200 || wechat?.status !== "ready" || wechat?.configuration?.callback_verified !== true) throw new Error("Validated WeChat connection was not persisted");

  process.env.PHONE_VERIFICATION_PEPPER = "phase-4-4-3-synthetic-phone-pepper-at-least-32-characters";
  const phoneChallenge = await issuePhoneVerification("+86 138-0013-8000", "registration", { code: "482731" });
  if (await verifyPhoneChallenge(phoneChallenge.challenge_id, "000000")) throw new Error("Incorrect phone verification code was accepted");
  if (!(await verifyPhoneChallenge(phoneChallenge.challenge_id, "482731"))) throw new Error("Correct phone verification code was rejected");
  if (await verifyPhoneChallenge(phoneChallenge.challenge_id, "482731")) throw new Error("Phone verification challenge was reusable");

  console.log("Phase 4.4.3 baseline E2E passed: platform diagnostics boundary, phone verification state machine and synthetic WeChat onboarding");
} finally {
  await pool.query(`DELETE FROM phone_verification_challenges WHERE phone_e164='+8613800138000' AND purpose='registration'`);
  await pool.query(`UPDATE console_sessions SET revoked_at=COALESCE(revoked_at,NOW()),revoke_reason=COALESCE(revoke_reason,'test_cleanup') WHERE token_hash=encode(digest($1,'sha256'),'hex')`, [token]);
  await pool.end();
}
