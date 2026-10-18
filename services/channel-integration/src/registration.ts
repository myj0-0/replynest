import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { createConsoleSession } from "./console-auth.js";
import { hashConsolePassword } from "./console-password.js";
import { pool } from "./database.js";
import { sendMail } from "./mail-provider.js";
import { issuePhoneVerification, verifyPhoneChallenge } from "./phone-verification.js";
import { normalizeMainlandPhone } from "./sms-provider.js";
import { provisionChatwootWorkspace, type ChatwootSsoAdapterConfig } from "./chatwoot-sso-adapter.js";
import { claimTrial } from "./trial.js";
import { attributeReferral } from "./referral.js";
import { requiredEnv } from "./shared.js";
import { requireRegistrationInvite, reserveRegistrationVerification, type RegistrationRiskContext } from "./registration-security.js";
import { validateRegistrationLegalConsent } from "./registration-legal.js";

const EMAIL = /^\S+@\S+\.\S+$/;
const TOKEN = /^[a-f0-9]{64}$/i;

export class RegistrationInputError extends Error { constructor(public code: string) { super(code); } }
export class RegistrationConflictError extends Error { constructor(public code: string) { super(code); } }
export class RegistrationGoneError extends Error { constructor(public code: string) { super(code); } }

export type RegistrationDependencies = {
  sendEmail: typeof sendMail;
  issuePhone: typeof issuePhoneVerification;
  verifyPhone: typeof verifyPhoneChallenge;
  provisionWorkspace: typeof provisionChatwootWorkspace;
};

const defaults: RegistrationDependencies = {
  sendEmail: sendMail,
  issuePhone: issuePhoneVerification,
  verifyPhone: verifyPhoneChallenge,
  provisionWorkspace: provisionChatwootWorkspace,
};

type Attempt = {
  registration_id: string; idempotency_key: string; request_fingerprint: string; resume_token_hash: string; email: string;
  display_name: string; company_name: string; phone_e164: string; password_hash: string | null;
  referral_code: string | null; proposed_tenant_id: string; phone_challenge_id: string | null;
  pilot_invite_id: string | null;
  status: string; email_expires_at: Date; email_verified_at: Date | null; phone_verified_at: Date | null;
  chatwoot_account_id: string | null; chatwoot_user_id: string | null; platform_user_id: string | null;
  tenant_id: string | null; expires_at: Date;
};

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function fingerprint(value: object) { return hash(JSON.stringify(value)); }
function workspaceId() { return `rn-${randomUUID()}`; }
function publicOrigin() { return requiredEnv("CONSOLE_PUBLIC_ORIGIN").replace(/\/$/, ""); }
function adapterConfig(): ChatwootSsoAdapterConfig {
  return { internalBaseUrl: requiredEnv("CHATWOOT_BASE_URL"), publicBaseUrl: requiredEnv("CHATWOOT_PUBLIC_URL"), sharedSecret: requiredEnv("SAAS_SSO_SHARED_SECRET") };
}
async function event(client: PoolClient, registrationId: string, eventType: string, requestId: string, facts: Record<string, unknown> = {}) {
  await client.query(`INSERT INTO registration_events(registration_id,event_type,facts,request_id) VALUES($1,$2,$3::jsonb,$4)`, [registrationId, eventType, JSON.stringify(facts), requestId]);
}
function publicAttempt(row: Attempt) {
  return {
    registration_id: row.registration_id,
    status: row.status,
    email: row.email.replace(/^(.{1,2}).*(@.*)$/, "$1***$2"),
    phone: row.phone_e164.replace(/^(\+861\d{2})\d{4}(\d{4})$/, "$1****$2"),
    email_verified: Boolean(row.email_verified_at),
    phone_verified: Boolean(row.phone_verified_at),
    expires_at: row.expires_at,
    completed: row.status === "completed" ? { tenant_id: row.tenant_id } : null,
  };
}
async function authenticatedAttempt(resumeToken: string, lock = false, client?: PoolClient): Promise<Attempt> {
  if (!TOKEN.test(resumeToken)) throw new RegistrationInputError("invalid_registration_token");
  const db = client ?? pool;
  const result = await db.query<Attempt>(`SELECT * FROM registration_attempts WHERE resume_token_hash=$1${lock ? " FOR UPDATE" : ""}`, [hash(resumeToken)]);
  const row = result.rows[0];
  if (!row) throw new RegistrationGoneError("registration_not_found");
  if (row.expires_at <= new Date()) {
    if (row.status !== "completed") await db.query(`UPDATE registration_attempts SET status='expired',failure_code='registration_expired',updated_at=NOW() WHERE registration_id=$1 AND status NOT IN ('completed','failed','expired')`, [row.registration_id]);
    throw new RegistrationGoneError("registration_expired");
  }
  return row;
}

export async function startRegistration(input: {
  email: string; display_name: string; company_name: string; phone: string; password: string;
  referral_code?: string; idempotency_key: string; resume_token?: string; legal_accepted: boolean; terms_version: string; privacy_version: string;
}, requestId = randomUUID(), deps: RegistrationDependencies = defaults, testOptions?: { phone_code?: string; risk_context?: RegistrationRiskContext }) {
  const email = input.email.trim().toLowerCase();
  const displayName = input.display_name.trim().slice(0, 200);
  const companyName = input.company_name.trim().slice(0, 200);
  const phone = normalizeMainlandPhone(input.phone);
  const idempotencyKey = input.idempotency_key.trim();
  const resumeToken = input.resume_token ?? randomBytes(32).toString("hex");
  const referralCode = input.referral_code?.trim() || null;
  const legal = validateRegistrationLegalConsent({ accepted: input.legal_accepted, terms_version: input.terms_version, privacy_version: input.privacy_version });
  if (!legal.valid) throw new RegistrationInputError(legal.code);
  if (!EMAIL.test(email) || !displayName || !companyName || !phone || input.password.length < 12 || input.password.length > 128 || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey) || !TOKEN.test(resumeToken)) throw new RegistrationInputError("invalid_registration_input");
  if (referralCode && !/^[A-Za-z0-9_-]{20,64}$/.test(referralCode)) throw new RegistrationInputError("invalid_referral_code");
  const normalized = { email, display_name: displayName, company_name: companyName, phone_e164: `+86${phone}`, referral_code: referralCode, password_digest: hash(input.password), terms_version: legal.terms_version, privacy_version: legal.privacy_version };
  const requestFingerprint = fingerprint(normalized);
  const existing = await pool.query<Attempt>(`SELECT * FROM registration_attempts WHERE idempotency_key=$1`, [idempotencyKey]);
  if (existing.rows[0]) {
    if (existing.rows[0].request_fingerprint !== requestFingerprint) throw new RegistrationConflictError("idempotency_key_reused");
    if (existing.rows[0].resume_token_hash !== hash(resumeToken)) throw new RegistrationConflictError("registration_token_mismatch");
    return { ...publicAttempt(existing.rows[0]), registration_token: resumeToken, idempotent_replay: true };
  }
  const inviteAccess = await requireRegistrationInvite(referralCode);
  const occupied = await pool.query(`SELECT 1 FROM platform_users WHERE email=$1 OR (phone_e164=$2 AND phone_verified_at IS NOT NULL) LIMIT 1`, [email, normalized.phone_e164]);
  if (occupied.rowCount) throw new RegistrationConflictError("identity_already_registered");
  await reserveRegistrationVerification({ email, phone_e164: normalized.phone_e164, context: testOptions?.risk_context }, requestId);
  const passwordHash = await hashConsolePassword(input.password);
  const emailToken = randomBytes(32).toString("hex");
  const client = await pool.connect();
  let attempt: Attempt;
  try {
    await client.query("BEGIN");
    const lockedAccess = inviteAccess.kind === "pilot" ? await requireRegistrationInvite(referralCode, new Date(), client, true) : inviteAccess;
    const inserted = await client.query<Attempt>(
      `INSERT INTO registration_attempts(idempotency_key,request_fingerprint,resume_token_hash,email_token_hash,email,display_name,company_name,phone_e164,password_hash,referral_code,pilot_invite_id,proposed_tenant_id,terms_version,privacy_version,legal_consented_at,email_expires_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW()+INTERVAL '30 minutes',NOW()+INTERVAL '30 minutes') RETURNING *`,
      [idempotencyKey, requestFingerprint, hash(resumeToken), hash(emailToken), email, displayName, companyName, normalized.phone_e164, passwordHash, lockedAccess.kind === "pilot" ? null : referralCode, lockedAccess.kind === "pilot" ? lockedAccess.pilot_invite_id : null, workspaceId(), legal.terms_version, legal.privacy_version]
    );
    attempt = inserted.rows[0];
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
  await pool.query(`INSERT INTO registration_events(registration_id,event_type,facts,request_id) VALUES($1,'registration.started',$2::jsonb,$3)`, [attempt.registration_id, JSON.stringify({ email_domain: email.split("@")[1], access_kind: inviteAccess.kind, referral_supplied: Boolean(attempt.referral_code), pilot_invite: Boolean(attempt.pilot_invite_id), terms_version: legal.terms_version, privacy_version: legal.privacy_version }), requestId]);
  try {
    const challenge = await deps.issuePhone(phone, "registration", testOptions?.phone_code ? { code: testOptions.phone_code } : undefined);
    await pool.query(`UPDATE registration_attempts SET phone_challenge_id=$2,updated_at=NOW() WHERE registration_id=$1`, [attempt.registration_id, challenge.challenge_id]);
    const verifyUrl = `${publicOrigin()}/register/verify-email?token=${emailToken}`;
    await deps.sendEmail({ to: email, subject: "验证您的答巢企业账号", text: `请在 30 分钟内打开以下链接验证邮箱：\n\n${verifyUrl}\n\n完成邮箱和中国大陆手机号验证后，才会创建企业工作区。` });
    await pool.query(`INSERT INTO registration_events(registration_id,event_type,facts,request_id) VALUES($1,'verification.dispatched',$2::jsonb,$3)`, [attempt.registration_id, JSON.stringify({ phone_challenge_id: challenge.challenge_id }), requestId]);
    return { ...publicAttempt({ ...attempt, phone_challenge_id: challenge.challenge_id }), registration_token: resumeToken, idempotent_replay: false };
  } catch (error) {
    await pool.query(`UPDATE registration_attempts SET status='failed',failure_code='verification_delivery_failed',updated_at=NOW() WHERE registration_id=$1`, [attempt.registration_id]);
    await pool.query(`UPDATE phone_verification_challenges SET consumed_at=COALESCE(consumed_at,NOW()) WHERE challenge_id=(SELECT phone_challenge_id FROM registration_attempts WHERE registration_id=$1)`, [attempt.registration_id]);
    throw error;
  }
}

export async function verifyRegistrationEmail(emailToken: string, requestId = randomUUID()) {
  if (!TOKEN.test(emailToken)) throw new RegistrationInputError("invalid_email_token");
  const updated = await pool.query<Attempt>(
    `UPDATE registration_attempts SET email_verified_at=COALESCE(email_verified_at,NOW()),
       status=CASE WHEN phone_verified_at IS NOT NULL THEN 'ready' ELSE status END,updated_at=NOW()
     WHERE email_token_hash=$1 AND status IN ('awaiting_verification','ready') AND email_expires_at>NOW() RETURNING *`, [hash(emailToken)]
  );
  if (!updated.rows[0]) throw new RegistrationGoneError("email_token_expired");
  await pool.query(`INSERT INTO registration_events(registration_id,event_type,request_id) VALUES($1,'email.verified',$2)`, [updated.rows[0].registration_id, requestId]);
  return publicAttempt(updated.rows[0]);
}

export async function verifyRegistrationPhone(resumeToken: string, code: string, requestId = randomUUID(), deps: RegistrationDependencies = defaults) {
  const attempt = await authenticatedAttempt(resumeToken);
  if (!attempt.phone_challenge_id || !["awaiting_verification", "ready"].includes(attempt.status)) throw new RegistrationConflictError("registration_not_verifiable");
  const challenge = await pool.query<{ phone_e164: string; purpose: string }>(`SELECT phone_e164,purpose FROM phone_verification_challenges WHERE challenge_id=$1`, [attempt.phone_challenge_id]);
  if (challenge.rows[0]?.phone_e164 !== attempt.phone_e164 || challenge.rows[0]?.purpose !== "registration") throw new RegistrationConflictError("phone_challenge_mismatch");
  if (!(await deps.verifyPhone(attempt.phone_challenge_id, code))) throw new RegistrationInputError("invalid_phone_code");
  const updated = await pool.query<Attempt>(
    `UPDATE registration_attempts SET phone_verified_at=COALESCE(phone_verified_at,NOW()),
       status=CASE WHEN email_verified_at IS NOT NULL THEN 'ready' ELSE status END,updated_at=NOW()
     WHERE registration_id=$1 AND status IN ('awaiting_verification','ready') RETURNING *`, [attempt.registration_id]
  );
  await pool.query(`INSERT INTO registration_events(registration_id,event_type,request_id) VALUES($1,'phone.verified',$2)`, [attempt.registration_id, requestId]);
  return publicAttempt(updated.rows[0]);
}

export async function registrationStatus(resumeToken: string) { return publicAttempt(await authenticatedAttempt(resumeToken)); }

export async function completeRegistration(resumeToken: string, requestId = randomUUID(), deps: RegistrationDependencies = defaults) {
  let attempt = await authenticatedAttempt(resumeToken);
  if (attempt.status === "completed" && attempt.platform_user_id && attempt.tenant_id) {
    const session = await createConsoleSession(attempt.platform_user_id, attempt.tenant_id);
    return { ...publicAttempt(attempt), session, idempotent_replay: true };
  }
  if (!attempt.email_verified_at || !attempt.phone_verified_at || !["ready", "provisioning"].includes(attempt.status)) throw new RegistrationConflictError("verification_incomplete");
  if (attempt.status === "ready") {
    const claimed = await pool.query<Attempt>(`UPDATE registration_attempts SET status='provisioning',updated_at=NOW() WHERE registration_id=$1 AND status='ready' RETURNING *`, [attempt.registration_id]);
    attempt = claimed.rows[0] ?? await authenticatedAttempt(resumeToken);
  }
  const client = await pool.connect();
  let platformUserId = "";
  try {
    await client.query("BEGIN");
    const locked = await authenticatedAttempt(resumeToken, true, client);
    if (locked.status === "completed" && locked.platform_user_id) {
      platformUserId = locked.platform_user_id;
      await client.query("COMMIT");
    } else {
      const conflict = await client.query(`SELECT 1 FROM platform_users WHERE email=$1 OR (phone_e164=$2 AND phone_verified_at IS NOT NULL) LIMIT 1`, [locked.email, locked.phone_e164]);
      if (conflict.rowCount) throw new RegistrationConflictError("identity_already_registered");
      if (!locked.password_hash) throw new RegistrationConflictError("registration_credentials_unavailable");
      if (locked.pilot_invite_id) {
        const active=await client.query(`SELECT 1 FROM registration_pilot_invites i JOIN registration_pilot_batches b ON b.pilot_batch_id=i.pilot_batch_id WHERE i.pilot_invite_id=$1 AND i.status='active' AND i.expires_at>NOW() AND b.status='active' AND b.starts_at<=NOW() AND b.ends_at>NOW() FOR UPDATE OF b,i`,[locked.pilot_invite_id]);
        if(!active.rowCount) throw new RegistrationConflictError("pilot_invite_no_longer_active");
      }
      const provisioned = await deps.provisionWorkspace({ workspace_key: locked.proposed_tenant_id, company_name: locked.company_name, email: locked.email, name: locked.display_name }, adapterConfig());
      if (locked.pilot_invite_id) {
        const consumed=await client.query(`UPDATE registration_pilot_invites i SET status='consumed',consumed_at=NOW() FROM registration_pilot_batches b WHERE i.pilot_invite_id=$1 AND b.pilot_batch_id=i.pilot_batch_id AND i.status='active' AND i.expires_at>NOW() AND b.status='active' AND b.starts_at<=NOW() AND b.ends_at>NOW() RETURNING i.pilot_invite_id`,[locked.pilot_invite_id]);
        if(!consumed.rowCount) throw new RegistrationConflictError("pilot_invite_no_longer_active");
      }
      await client.query(`INSERT INTO tenants(tenant_id,name,status,chatwoot_account_id,signup_source,referral_code_entered) VALUES($1,$2,'active',$3,$4,$5)`, [locked.proposed_tenant_id, locked.company_name, provisioned.account_id, locked.pilot_invite_id?"pilot_invite":"self_service", locked.referral_code]);
      const user = await client.query<{ platform_user_id: string }>(`INSERT INTO platform_users(email,display_name,password_hash,status,email_verified_at,phone_e164,phone_verified_at) VALUES($1,$2,$3,'active',$4,$5,$6) RETURNING platform_user_id`, [locked.email, locked.display_name, locked.password_hash, locked.email_verified_at, locked.phone_e164, locked.phone_verified_at]);
      platformUserId = user.rows[0].platform_user_id;
      await client.query(`INSERT INTO tenant_memberships(tenant_id,platform_user_id,role,status,chatwoot_user_id,chatwoot_user_email,chatwoot_account_id,chatwoot_sync_status,chatwoot_synced_at) VALUES($1,$2,'tenant_admin','active',$3,$4,$5,'synced',NOW())`, [locked.proposed_tenant_id, platformUserId, provisioned.user_id, locked.email, provisioned.account_id]);
      const subscription = await client.query<{ subscription_id: string }>(`INSERT INTO tenant_subscriptions(tenant_id,plan_version_id,status,source,current_period_start,current_period_end,price_minor_snapshot,currency_snapshot,entitlement_snapshot) SELECT $1,plan_version_id,'active','free_baseline',NOW(),'2099-12-31T23:59:59Z',price_minor,currency,entitlement_rules FROM plan_catalog_versions WHERE plan_code='free' AND status='active' RETURNING subscription_id`, [locked.proposed_tenant_id]);
      await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,event_key,facts) VALUES($1,$2,'created','self_service',$3,jsonb_build_object('status','active','plan','free'))`, [locked.proposed_tenant_id, subscription.rows[0].subscription_id, `registration:${locked.registration_id}`]);
      await client.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id) VALUES($1,'platform_user',$2,'tenant.self_service_registered','tenant',$1,jsonb_build_object('email_verified',true,'phone_verified',true),$3)`, [locked.proposed_tenant_id, platformUserId, requestId]);
      await client.query(`UPDATE phone_verification_challenges SET consumed_at=COALESCE(consumed_at,NOW()) WHERE challenge_id=$1 AND verified_at IS NOT NULL`, [locked.phone_challenge_id]);
      const done = await client.query<Attempt>(`UPDATE registration_attempts SET status='completed',chatwoot_account_id=$2,chatwoot_user_id=$3,platform_user_id=$4,tenant_id=proposed_tenant_id,password_hash=NULL,completed_at=NOW(),updated_at=NOW() WHERE registration_id=$1 RETURNING *`, [locked.registration_id, provisioned.account_id, provisioned.user_id, platformUserId]);
      await event(client, locked.registration_id, "registration.completed", requestId, { tenant_id: locked.proposed_tenant_id, plan: "free", access_kind: locked.pilot_invite_id?"pilot":"referral_or_public" });
      attempt = done.rows[0];
      await client.query("COMMIT");
    }
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
  const actor = { actor_type: "internal_service" as const, actor_id: "self-service-registration", request_id: requestId };
  let trial: Record<string, unknown> = { outcome: "unavailable" };
  try { const result = await claimTrial(attempt.tenant_id!, "professional-trial-cn", actor); trial = { outcome: "claimed", entitlement_id: result.entitlement_id }; }
  catch (error) { trial = { outcome: "not_claimed", reason: error instanceof Error ? error.message.slice(0, 160) : "unknown" }; }
  let referral: Record<string, unknown> = { outcome: attempt.referral_code ? "not_attributed" : "not_supplied" };
  if (attempt.referral_code) {
    try { const result = await attributeReferral(attempt.referral_code, attempt.tenant_id!, platformUserId, actor); referral = { outcome: "attributed", referral_id: result.referral_id }; }
    catch (error) { referral = { outcome: "not_attributed", reason: error instanceof Error ? error.message.slice(0, 160) : "unknown" }; }
  }
  const session = await createConsoleSession(platformUserId, attempt.tenant_id!);
  return { ...publicAttempt(attempt), session, trial, referral, idempotent_replay: false };
}
