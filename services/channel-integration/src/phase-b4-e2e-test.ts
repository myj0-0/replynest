import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { ledgerBalances } from "./ledger.js";
import { attributeReferral, createOrGetInviteCode, invalidateReferralPayment, qualifyMaturedReferrals, recordReferralPayment } from "./referral.js";
import { reconcileReferralRewards, recordTenantRiskSignal, reviewReferral } from "./referral-risk.js";

process.env.RISK_SIGNAL_PEPPER ||= "phase-b4-synthetic-pepper-with-at-least-32-characters";
const marker = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const accountBase = BigInt(Date.now()) * 100n;
const actor = () => ({ actor_type: "internal_service" as const, actor_id: "phase-b4-e2e", request_id: randomUUID() });

async function tenant(suffix: string, offset: number, paid = false) {
  const tenantId = `phase-b4-${marker}-${suffix}`;
  const email = `${tenantId}@example.test`;
  await pool.query(`INSERT INTO tenants(tenant_id,name,status,chatwoot_account_id,signup_source) VALUES($1,$1,'test',$2,'synthetic-phase-b4')`, [tenantId, (accountBase + BigInt(offset)).toString()]);
  const user = await pool.query<{ platform_user_id: string }>(`INSERT INTO platform_users(email,display_name,status,email_verified_at) VALUES($1,$1,'active',NOW()) RETURNING platform_user_id`, [email]);
  await pool.query(`INSERT INTO tenant_memberships(tenant_id,platform_user_id,role,status,chatwoot_user_id,chatwoot_user_email,chatwoot_account_id) VALUES($1,$2,'tenant_admin','active',$3,$4,$5)`, [tenantId, user.rows[0].platform_user_id, offset + 1000, email, (accountBase + BigInt(offset)).toString()]);
  if (paid) await pool.query(`INSERT INTO tenant_commercial_profiles(tenant_id,billing_status,lifetime_cash_paid_minor,first_paid_at,updated_by) VALUES($1,'paid',10000,NOW(),'phase-b4-e2e')`, [tenantId]);
  return { tenantId, userId: user.rows[0].platform_user_id };
}

async function paidReferral(code: string, suffix: string, offset: number) {
  const invitee = await tenant(suffix, offset);
  const referral = await attributeReferral(code, invitee.tenantId, invitee.userId, actor());
  const paidAt = new Date();
  await recordReferralPayment(referral.referral_id, {
    source_type: "synthetic_order", source_id: `phase-b4-payment-${marker}-${suffix}`,
    cash_paid_minor: 15000, currency: "CNY", occurred_at: paidAt.toISOString(), metadata: { synthetic: true },
  }, actor());
  return { invitee, referral, matureAt: new Date(paidAt.getTime() + 8 * 86_400_000) };
}

const inviter = await tenant("inviter", 1, true);
const code = await createOrGetInviteCode(inviter.tenantId, inviter.userId, actor());

const high = await paidReferral(code.invite_code, "high", 2);
await recordTenantRiskSignal(inviter.tenantId, "payment_subject", `pay-subject-${marker}`, "synthetic_payment", "phase-b4-e2e");
await recordTenantRiskSignal(high.invitee.tenantId, "payment_subject", `pay-subject-${marker}`, "synthetic_payment", "phase-b4-e2e");
assert.equal(await qualifyMaturedReferrals(high.matureAt, "phase-b4-e2e", high.referral.referral_id), 0);
assert.equal((await pool.query(`SELECT status,risk_score FROM referrals WHERE referral_id=$1`, [high.referral.referral_id])).rows[0].status, "rejected");
assert.equal((await pool.query(`SELECT COUNT(*)::int count FROM referral_reward_grants WHERE referral_id=$1`, [high.referral.referral_id])).rows[0].count, 0);

const medium = await paidReferral(code.invite_code, "medium", 3);
await recordTenantRiskSignal(inviter.tenantId, "device", `device-${marker}`, "synthetic_device_cookie", "phase-b4-e2e");
await recordTenantRiskSignal(medium.invitee.tenantId, "device", `device-${marker}`, "synthetic_device_cookie", "phase-b4-e2e");
assert.equal(await qualifyMaturedReferrals(medium.matureAt, "phase-b4-e2e", medium.referral.referral_id), 0);
assert.equal((await pool.query(`SELECT status FROM referrals WHERE referral_id=$1`, [medium.referral.referral_id])).rows[0].status, "review");
assert.equal((await pool.query(`SELECT COUNT(*)::int count FROM referral_reward_grants WHERE referral_id=$1`, [medium.referral.referral_id])).rows[0].count, 0);
await reviewReferral(medium.referral.referral_id, "approved", "synthetic evidence confirms separate companies", actor());
const grants = await pool.query(`SELECT beneficiary_role,status,amount_minor::text FROM referral_reward_grants WHERE referral_id=$1 ORDER BY beneficiary_role`, [medium.referral.referral_id]);
assert.deepEqual(grants.rows, [
  { beneficiary_role: "invitee", status: "posted", amount_minor: "3000" },
  { beneficiary_role: "inviter", status: "posted", amount_minor: "5000" },
]);
assert.equal((await ledgerBalances(inviter.tenantId)).accounts.find(item => item.account === "referral")?.balance_minor, "5000");
assert.equal((await ledgerBalances(medium.invitee.tenantId)).accounts.find(item => item.account === "gift")?.balance_minor, "3000");

const low = await paidReferral(code.invite_code, "low", 4);
await recordTenantRiskSignal(inviter.tenantId, "ip_network", "203.0.113.0/24", "synthetic_edge", "phase-b4-e2e");
await recordTenantRiskSignal(low.invitee.tenantId, "ip_network", "203.0.113.0/24", "synthetic_edge", "phase-b4-e2e");
const results = await Promise.all(Array.from({ length: 12 }, () => qualifyMaturedReferrals(low.matureAt, "phase-b4-e2e", low.referral.referral_id)));
assert.equal(results.reduce((sum, value) => sum + value, 0), 1);
assert.equal((await pool.query(`SELECT status,risk_score FROM referrals WHERE referral_id=$1`, [low.referral.referral_id])).rows[0].status, "qualified");
assert.equal((await pool.query(`SELECT COUNT(*)::int count FROM referral_reward_grants WHERE referral_id=$1 AND status='posted'`, [low.referral.referral_id])).rows[0].count, 2);

await invalidateReferralPayment(medium.referral.referral_id, "synthetic_order", `phase-b4-chargeback-${marker}`, "payment_chargeback", "synthetic chargeback", actor());
assert.equal((await ledgerBalances(inviter.tenantId)).accounts.find(item => item.account === "referral")?.balance_minor, "5000");
assert.equal((await ledgerBalances(medium.invitee.tenantId)).accounts.find(item => item.account === "gift")?.balance_minor, "0");
assert.equal((await pool.query(`SELECT COUNT(*)::int count FROM referral_reward_grants WHERE referral_id=$1 AND status='reversed'`, [medium.referral.referral_id])).rows[0].count, 2);
assert.equal(await reconcileReferralRewards("phase-b4-e2e-reconcile"), 0);

const rawLeak = await pool.query(`SELECT COUNT(*)::int count FROM tenant_risk_signals WHERE fingerprint_hash LIKE $1`, [`%${marker}%`]);
assert.equal(rawLeak.rows[0].count, 0);
await assert.rejects(() => pool.query(`DELETE FROM referral_risk_assessments WHERE referral_id=$1`, [high.referral.referral_id]));
await assert.rejects(() => pool.query(`UPDATE tenant_risk_signals SET source='tampered' WHERE tenant_id=$1`, [inviter.tenantId]));
await assert.rejects(() => pool.query(`DELETE FROM referral_manual_reviews WHERE referral_id=$1`, [medium.referral.referral_id]));
await assert.rejects(() => pool.query(`UPDATE referral_reward_grants SET amount_minor=1 WHERE referral_id=$1`, [low.referral.referral_id]));

console.log(`phase_b4_e2e=ok marker=${marker} high_confidence_rejected=true device_reviewed=true manual_approval_rewarded=true ip_only_allowed=true concurrent_maturity=12 raw_signals_stored=false chargeback_reversed=true append_only=true`);
await pool.end();
