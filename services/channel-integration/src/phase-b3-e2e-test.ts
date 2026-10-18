import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { attributeReferral, createOrGetInviteCode, invalidateReferralPayment, qualifyMaturedReferrals, recordReferralPayment, ReferralConflictError, ReferralEligibilityError } from "./referral.js";

const marker = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const accountBase = BigInt(Date.now()) * 100n;
const actor = () => ({ actor_type: "internal_service" as const, actor_id: "phase-b3-e2e", request_id: randomUUID() });

async function tenant(suffix: string, offset: number, paid = false) {
  const tenantId = `phase-b3-${marker}-${suffix}`;
  const email = `${tenantId}@example.test`;
  await pool.query(`INSERT INTO tenants(tenant_id,name,status,chatwoot_account_id,signup_source) VALUES($1,$1,'test',$2,'synthetic-phase-b3')`, [tenantId, (accountBase + BigInt(offset)).toString()]);
  const user = await pool.query<{ platform_user_id: string }>(`INSERT INTO platform_users(email,display_name,status,email_verified_at) VALUES($1,$1,'active',NOW()) RETURNING platform_user_id`, [email]);
  await pool.query(`INSERT INTO tenant_memberships(tenant_id,platform_user_id,role,status,chatwoot_user_id,chatwoot_user_email,chatwoot_account_id) VALUES($1,$2,'tenant_admin','active',$3,$4,$5)`, [tenantId, user.rows[0].platform_user_id, offset, email, (accountBase + BigInt(offset)).toString()]);
  if (paid) await pool.query(`INSERT INTO tenant_commercial_profiles(tenant_id,billing_status,lifetime_cash_paid_minor,first_paid_at,updated_by) VALUES($1,'paid',10000,NOW(),'phase-b3-e2e')`, [tenantId]);
  return { tenantId, userId: user.rows[0].platform_user_id };
}

const inviter = await tenant("inviter", 1, true);
const alternate = await tenant("alternate", 2, true);
const freeTenant = await tenant("free", 3, false);
await assert.rejects(() => createOrGetInviteCode(freeTenant.tenantId, freeTenant.userId, actor()), (error: unknown) => error instanceof ReferralEligibilityError && error.reason_codes.includes("paid_tenant_required"));

const codes = await Promise.all(Array.from({ length: 12 }, () => createOrGetInviteCode(inviter.tenantId, inviter.userId, actor())));
assert.equal(new Set(codes.map(row => row.invite_code_id)).size, 1);
assert.ok(codes.every(row => row.invite_code === codes[0].invite_code));
assert.equal(String(codes[0].invite_code).includes(inviter.tenantId), false);
const alternateCode = await createOrGetInviteCode(alternate.tenantId, alternate.userId, actor());
await assert.rejects(() => attributeReferral(codes[0].invite_code, inviter.tenantId, inviter.userId, actor()), (error: unknown) => error instanceof ReferralEligibilityError && error.reason_codes.includes("self_invitation"));

const inviteeA = await tenant("invitee-a", 4);
const inviteeB = await tenant("invitee-b", 5);
const inviteeC = await tenant("invitee-c", 6);
const referralsA = await Promise.all(Array.from({ length: 12 }, () => attributeReferral(codes[0].invite_code, inviteeA.tenantId, inviteeA.userId, actor())));
assert.equal(new Set(referralsA.map(row => row.referral_id)).size, 1);
const referralA = referralsA[0];
await assert.rejects(() => attributeReferral(alternateCode.invite_code, inviteeA.tenantId, inviteeA.userId, actor()), ReferralConflictError);

const referralB = await attributeReferral(codes[0].invite_code, inviteeB.tenantId, inviteeB.userId, actor());
const rejected = await recordReferralPayment(referralB.referral_id, { source_type: "synthetic_order", source_id: `low-${marker}`, cash_paid_minor: 9999, currency: "CNY", occurred_at: new Date().toISOString(), metadata: { synthetic: true } }, actor());
assert.equal(rejected.status, "rejected");

const occurredAt = new Date();
const pending = await recordReferralPayment(referralA.referral_id, { source_type: "synthetic_order", source_id: `valid-${marker}`, cash_paid_minor: 15000, currency: "CNY", occurred_at: occurredAt.toISOString(), metadata: { synthetic: true, gift_paid_minor: 0 } }, actor());
assert.equal(pending.status, "pending");
assert.equal(await qualifyMaturedReferrals(new Date(occurredAt.getTime() + 6 * 86_400_000), "phase-b3-e2e", referralA.referral_id, false), 0);
assert.equal(await qualifyMaturedReferrals(new Date(occurredAt.getTime() + 8 * 86_400_000), "phase-b3-e2e", referralA.referral_id, false), 1);
const revoked = await invalidateReferralPayment(referralA.referral_id, "synthetic_order", `chargeback-${marker}`, "payment_chargeback", "synthetic post-observation chargeback", actor());
assert.equal(revoked.status, "revoked");
assert.equal((await invalidateReferralPayment(referralA.referral_id, "synthetic_order", `chargeback-${marker}`, "payment_chargeback", "idempotent replay", actor())).status, "revoked");

const referralC = await attributeReferral(codes[0].invite_code, inviteeC.tenantId, inviteeC.userId, actor());
await recordReferralPayment(referralC.referral_id, { source_type: "synthetic_order", source_id: `refund-${marker}`, cash_paid_minor: 12000, currency: "CNY", occurred_at: new Date().toISOString(), metadata: { synthetic: true } }, actor());
assert.equal((await invalidateReferralPayment(referralC.referral_id, "synthetic_order", `refund-event-${marker}`, "payment_refunded", "synthetic refund in observation", actor())).status, "rejected");

const counts = await pool.query<{ codes: string; referrals: string; qualification_events: string; status_events: string; rewards: string }>(
  `SELECT
    (SELECT COUNT(*)::text FROM referral_invite_codes WHERE inviter_tenant_id=ANY($1::text[])) codes,
    (SELECT COUNT(*)::text FROM referrals WHERE inviter_tenant_id=$2) referrals,
    (SELECT COUNT(*)::text FROM referral_qualification_events e JOIN referrals r ON r.referral_id=e.referral_id WHERE r.inviter_tenant_id=$2) qualification_events,
    (SELECT COUNT(*)::text FROM referral_status_events WHERE tenant_id=$2) status_events,
    (SELECT COUNT(*)::text FROM ledger_transactions WHERE source_type='referral' AND source_id IN (SELECT referral_id::text FROM referrals WHERE inviter_tenant_id=$2)) rewards`,
  [[inviter.tenantId, alternate.tenantId], inviter.tenantId]
);
assert.deepEqual(counts.rows[0], { codes: "2", referrals: "3", qualification_events: "5", status_events: "9", rewards: "0" });
await assert.rejects(() => pool.query(`UPDATE referrals SET invitee_tenant_id=$2 WHERE referral_id=$1`, [referralA.referral_id, inviteeB.tenantId]));
await assert.rejects(() => pool.query(`DELETE FROM referral_status_events WHERE referral_id=$1`, [referralA.referral_id]));
await assert.rejects(() => pool.query(`DELETE FROM referral_qualification_events WHERE referral_id=$1`, [referralA.referral_id]));

console.log(`phase_b3_e2e=ok marker=${marker} code_concurrent=12 stable_code=true code_opaque=true self_invite_rejected=true attribution_concurrent=12 first_attribution_locked=true cash_only=true observation_enforced=true refund_rejected=true chargeback_revoked=true rewards_issued=0 append_only=true`);
await pool.end();
