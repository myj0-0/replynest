import { migrate, pool } from "./database.js";
import { completeRegistration, RegistrationConflictError, startRegistration, verifyRegistrationEmail, verifyRegistrationPhone, type RegistrationDependencies } from "./registration.js";
import { issuePhoneVerification, verifyPhoneChallenge } from "./phone-verification.js";
import { randomBytes } from "node:crypto";

process.env.PHONE_VERIFICATION_PEPPER ||= "phase-b6-synthetic-phone-pepper-at-least-32-characters";
process.env.SMS_PROVIDER = "mock";
process.env.REGISTRATION_ACCESS_MODE = "public";
process.env.REGISTRATION_RISK_PEPPER ||= "phase-b6-registration-risk-pepper-at-least-32-characters";
process.env.REGISTRATION_SMS_DAILY_BUDGET ||= "1000000";
process.env.REGISTRATION_LEGAL_PUBLISH_READY = "true";
process.env.REGISTRATION_TERMS_VERSION = "2026-09-11";
process.env.REGISTRATION_PRIVACY_VERSION = "2026-09-11";
process.env.CONSOLE_PUBLIC_ORIGIN ||= "http://localhost:3200";
process.env.CHATWOOT_BASE_URL ||= "http://chatwoot.invalid";
process.env.CHATWOOT_PUBLIC_URL ||= "http://chatwoot.invalid";
process.env.SAAS_SSO_SHARED_SECRET ||= "phase-b6-synthetic-sso-secret-at-least-32-characters";

await migrate();
const suffix = Date.now().toString(36);
const phone = `139${String(Date.now()).slice(-8)}`;
let verificationMail = "";
let provisionCalls = 0;
const accountId = Number(String(Date.now()).slice(-9));
const userId = accountId + 1;
const deps: RegistrationDependencies = {
  sendEmail: async mail => { verificationMail = mail.text; },
  issuePhone: issuePhoneVerification,
  verifyPhone: verifyPhoneChallenge,
  provisionWorkspace: async input => { provisionCalls += 1; return { account_id: accountId, user_id: userId, email: input.email, workspace_key: input.workspace_key }; },
};
const input = {
  email: `phase-b6-${suffix}@example.invalid`, display_name: "B6 Test Admin", company_name: `B6 Test ${suffix}`,
  phone, password: "Phase-B6-Strong-Password!", idempotency_key: `phase-b6-${suffix}-registration`,
  resume_token: randomBytes(32).toString("hex"),
  legal_accepted: true, terms_version: "2026-09-11", privacy_version: "2026-09-11",
};

const started = await startRegistration(input, undefined, deps, { phone_code: "246810" });
const replay = await startRegistration(input, undefined, deps, { phone_code: "246810" });
if (!replay.idempotent_replay || replay.registration_id !== started.registration_id) throw new Error("registration start was not idempotent");
let prematureBlocked = false;
try { await completeRegistration(input.resume_token, undefined, deps); }
catch (error) { prematureBlocked = error instanceof RegistrationConflictError; }
if (!prematureBlocked) throw new Error("registration completed without dual verification");
const emailToken = verificationMail.match(/token=([a-f0-9]{64})/i)?.[1];
if (!emailToken) throw new Error("verification email did not contain a token");
await verifyRegistrationEmail(emailToken);
await verifyRegistrationPhone(input.resume_token, "246810", undefined, deps);
const completed = await completeRegistration(input.resume_token, undefined, deps);
const completedReplay = await completeRegistration(input.resume_token, undefined, deps);
if (provisionCalls !== 1 || !completedReplay.idempotent_replay) throw new Error("completion was not idempotent");
const facts = await pool.query(
  `SELECT t.status,u.email_verified_at IS NOT NULL AS email_verified,u.phone_verified_at IS NOT NULL AS phone_verified,
          m.role,p.plan_code,r.password_hash IS NULL AS staged_password_removed,
          (SELECT consumed_at IS NOT NULL FROM phone_verification_challenges WHERE challenge_id=r.phone_challenge_id) AS phone_challenge_consumed,
          (SELECT COUNT(*)::int FROM registration_events e WHERE e.registration_id=r.registration_id) event_count
     FROM registration_attempts r JOIN tenants t ON t.tenant_id=r.tenant_id
     JOIN platform_users u ON u.platform_user_id=r.platform_user_id
     JOIN tenant_memberships m ON m.tenant_id=t.tenant_id AND m.platform_user_id=u.platform_user_id
     JOIN tenant_subscriptions s ON s.tenant_id=t.tenant_id AND s.status='active'
     JOIN plan_catalog_versions p ON p.plan_version_id=s.plan_version_id
    WHERE r.registration_id=$1`, [started.registration_id]
);
const row = facts.rows[0];
if (row?.status !== "active" || !row.email_verified || !row.phone_verified || row.role !== "tenant_admin" || row.plan_code !== "free" || !row.staged_password_removed || !row.phone_challenge_consumed || Number(row.event_count) < 5) throw new Error("completed registration facts are incomplete");
console.log(JSON.stringify({ phase: "B.6", dual_verification_enforced: true, start_idempotent: true, completion_idempotent: true, workspace_provision_calls: provisionCalls, tenant_id: completed.completed?.tenant_id, baseline_plan: row.plan_code, trial_outcome: "trial" in completed ? completed.trial : null, immutable_events: Number(row.event_count) }));
await pool.end();
