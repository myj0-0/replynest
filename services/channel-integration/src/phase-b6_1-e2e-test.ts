import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { migrate, pool } from "./database.js";
import { startRegistration, type RegistrationDependencies } from "./registration.js";
import { RegistrationAccessError, RegistrationRateLimitError } from "./registration-security.js";
import { issuePhoneVerification, verifyPhoneChallenge } from "./phone-verification.js";

process.env.PHONE_VERIFICATION_PEPPER ||= "phase-b6-1-phone-pepper-at-least-32-characters";
process.env.REGISTRATION_RISK_PEPPER = "phase-b6-1-risk-pepper-at-least-32-characters";
process.env.SMS_PROVIDER = "mock";
process.env.CONSOLE_PUBLIC_ORIGIN ||= "http://localhost:3200";
process.env.REGISTRATION_LEGAL_PUBLISH_READY = "true";
process.env.REGISTRATION_TERMS_VERSION = "2026-09-11";
process.env.REGISTRATION_PRIVACY_VERSION = "2026-09-11";
process.env.REGISTRATION_IP_STARTS_PER_HOUR = "1000";
process.env.REGISTRATION_DEVICE_STARTS_PER_HOUR = "1000";
process.env.REGISTRATION_EMAIL_STARTS_PER_DAY = "1000";
process.env.REGISTRATION_PHONE_STARTS_PER_DAY = "1000";

await migrate();
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const phoneBase = Number(String(Date.now()).slice(-8));
let smsIssues = 0;
let emailIssues = 0;
const deps: RegistrationDependencies = {
  sendEmail: async () => { emailIssues += 1; },
  issuePhone: async (phone, purpose, options) => { smsIssues += 1; return issuePhoneVerification(phone, purpose, options); },
  verifyPhone: verifyPhoneChallenge,
  provisionWorkspace: async () => { throw new Error("not used in B.6.1 gate test"); },
};
function registration(sequence: number, phoneTail = sequence) {
  const phone = `138${String((phoneBase + phoneTail) % 100_000_000).padStart(8, "0")}`;
  return {
    email: `phase-b6-1-${suffix}-${sequence}@example.invalid`, display_name: "B6.1 Test", company_name: `B6.1 ${sequence}`,
    phone, password: "Phase-B6.1-Strong-Password!", idempotency_key: `phase-b6-1-${suffix}-${sequence}`,
    resume_token: randomBytes(32).toString("hex"),
    legal_accepted: true, terms_version: "2026-09-11", privacy_version: "2026-09-11",
  };
}
const context = (sequence: number) => ({ ip: `198.51.100.${sequence}`, device_id: randomBytes(24).toString("base64url") });

process.env.REGISTRATION_ACCESS_MODE = "invite_only";
await assert.rejects(
  () => startRegistration(registration(1), randomUUID(), deps, { phone_code: "123456", risk_context: context(1) }),
  (error: unknown) => error instanceof RegistrationAccessError && error.code === "registration_invite_required"
);
await assert.rejects(
  () => startRegistration({ ...registration(2), referral_code: "AAAAAAAAAAAAAAAAAAAA" }, randomUUID(), deps, { phone_code: "123456", risk_context: context(2) }),
  (error: unknown) => error instanceof RegistrationAccessError && error.code === "registration_invite_invalid"
);
assert.equal(smsIssues, 0, "invite gate must run before SMS dispatch");

process.env.REGISTRATION_ACCESS_MODE = "public";
const before = await pool.query<{ reserved_count: number }>(`SELECT reserved_count FROM registration_verification_budgets WHERE budget_date=(NOW() AT TIME ZONE 'UTC')::date AND channel='sms'`);
const initialBudget = Number(before.rows[0]?.reserved_count ?? 0);
process.env.REGISTRATION_SMS_DAILY_BUDGET = String(initialBudget + 1);
const firstInput = registration(3);
const firstRequest = randomUUID();
const first = await startRegistration(firstInput, firstRequest, deps, { phone_code: "123456", risk_context: context(3) });
const replay = await startRegistration(firstInput, randomUUID(), deps, { phone_code: "123456", risk_context: context(3) });
assert.equal(replay.idempotent_replay, true);
assert.equal(replay.registration_id, first.registration_id);
await assert.rejects(
  () => startRegistration(registration(4), randomUUID(), deps, { phone_code: "123456", risk_context: context(4) }),
  (error: unknown) => error instanceof RegistrationRateLimitError && error.code === "registration_sms_budget_exhausted"
);
assert.equal(smsIssues, 1, "budget denial and idempotent replay must not dispatch SMS");
assert.equal(emailIssues, 1, "budget denial and idempotent replay must not dispatch email");

process.env.REGISTRATION_SMS_DAILY_BUDGET = "1000000";
process.env.REGISTRATION_PHONE_STARTS_PER_DAY = "1";
const limitedPhone = registration(5).phone;
await startRegistration({ ...registration(5), phone: limitedPhone }, randomUUID(), deps, { phone_code: "123456", risk_context: context(5) });
await assert.rejects(
  () => startRegistration({ ...registration(6), phone: limitedPhone }, randomUUID(), deps, { phone_code: "123456", risk_context: context(6) }),
  (error: unknown) => error instanceof RegistrationRateLimitError && error.code === "registration_rate_limited"
);

const security = await pool.query<{ count: number; min_length: number; max_length: number }>(
  `SELECT COUNT(*)::int count,MIN(char_length(signal_hash))::int min_length,MAX(char_length(signal_hash))::int max_length
     FROM registration_security_events WHERE request_id=$1`, [firstRequest]
);
assert.ok(Number(security.rows[0].count) >= 2);
assert.equal(security.rows[0].min_length, 64);
assert.equal(security.rows[0].max_length, 64);
await assert.rejects(() => pool.query(`UPDATE registration_security_events SET reason_code='tampered' WHERE request_id=$1`, [firstRequest]));

await pool.query(
  `UPDATE phone_verification_challenges SET consumed_at=COALESCE(consumed_at,NOW())
    WHERE challenge_id IN (SELECT phone_challenge_id FROM registration_attempts WHERE idempotency_key LIKE $1)`, [`phase-b6-1-${suffix}-%`]
);
await pool.query(
  `UPDATE registration_attempts SET status='failed',failure_code='synthetic_test_cleanup',updated_at=NOW()
    WHERE idempotency_key LIKE $1 AND status IN ('awaiting_verification','ready')`, [`phase-b6-1-${suffix}-%`]
);

console.log(JSON.stringify({ phase: "B.6.1", invite_gate_precedes_delivery: true, idempotent_replay_consumes_no_budget: true, daily_sms_budget_enforced: true, phone_rate_limit_enforced: true, raw_risk_signals_stored: false, append_only_security_events: true }));
await pool.end();
