import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { ledgerBalances } from "./ledger.js";
import { claimTrial, extendTrial, getTrialOverview, transitionTrial, TrialEligibilityError, TrialStateError } from "./trial.js";

const marker = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const tenantA = `phase-b2-${marker}-a`;
const tenantB = `phase-b2-${marker}-b`;
const tenantC = `phase-b2-${marker}-c`;
const tenantD = `phase-b2-${marker}-d`;
const accountBase = BigInt(Date.now()) * 10n;
const campaignKey = "professional-trial-cn";
const actor = () => ({ actor_type: "internal_service" as const, actor_id: "phase-b2-e2e", request_id: randomUUID() });

async function makeTenant(tenantId: string, accountOffset: number) {
  await pool.query(`INSERT INTO tenants(tenant_id,name,status,chatwoot_account_id,signup_source) VALUES($1,$2,'test',$3,'synthetic-phase-b2')`, [tenantId, tenantId, (accountBase + BigInt(accountOffset)).toString()]);
}

async function makeUser(email: string, verified: boolean) {
  const result = await pool.query<{ platform_user_id: string }>(`INSERT INTO platform_users(email,display_name,status,email_verified_at) VALUES($1,$2,'active',$3) RETURNING platform_user_id`, [email, email, verified ? new Date() : null]);
  return result.rows[0].platform_user_id;
}

async function addAdmin(tenantId: string, userId: string, accountOffset: number, email: string) {
  await pool.query(`INSERT INTO tenant_memberships(tenant_id,platform_user_id,role,status,chatwoot_user_id,chatwoot_user_email,chatwoot_account_id) VALUES($1,$2,'tenant_admin','active',$3,$4,$5)`, [tenantId, userId, accountOffset, email, (accountBase + BigInt(accountOffset)).toString()]);
}

for (const [tenant, offset] of [[tenantA, 1], [tenantB, 2], [tenantC, 3], [tenantD, 4]] as const) await makeTenant(tenant, offset);
const sharedEmail = `phase-b2-shared-${marker}@example.test`;
const sharedAdmin = await makeUser(sharedEmail, true);
await addAdmin(tenantA, sharedAdmin, 1, sharedEmail);
await addAdmin(tenantB, sharedAdmin, 2, sharedEmail);
const unverifiedEmail = `phase-b2-unverified-${marker}@example.test`;
await addAdmin(tenantC, await makeUser(unverifiedEmail, false), 3, unverifiedEmail);
const reviewEmail = `phase-b2-review-${marker}@example.test`;
await addAdmin(tenantD, await makeUser(reviewEmail, true), 4, reviewEmail);
await pool.query(`INSERT INTO tenant_trial_signals(tenant_id,risk_state,risk_reason_codes,updated_by) VALUES($1,'review',ARRAY['synthetic_review'],'phase-b2-e2e')`, [tenantD]);

const beforeCny = await ledgerBalances(tenantA, "CNY");
const beforeAic = await ledgerBalances(tenantA, "AIC");
const claimed = await Promise.all(Array.from({ length: 12 }, () => claimTrial(tenantA, campaignKey, actor())));
assert.equal(new Set(claimed.map(row => row.entitlement_id)).size, 1);
assert.ok(claimed.every(row => row.status === "active"));
const entitlementId = String(claimed[0].entitlement_id);

const stored = await pool.query<{ entitlements: string; grants: string }>(
  `SELECT (SELECT COUNT(*)::text FROM trial_entitlements WHERE tenant_id=$1 AND campaign_key=$2) entitlements,
          (SELECT COUNT(*)::text FROM ledger_transactions WHERE tenant_id=$1 AND source_type='trial_entitlement' AND source_id=$3 AND transaction_type<>'reversal') grants`,
  [tenantA, campaignKey, entitlementId]
);
assert.deepEqual(stored.rows[0], { entitlements: "1", grants: "2" });

await assert.rejects(() => claimTrial(tenantB, campaignKey, actor()), (error: unknown) => error instanceof TrialEligibilityError && error.reason_codes.includes("admin_used_trial_elsewhere"));
await assert.rejects(() => claimTrial(tenantC, campaignKey, actor()), (error: unknown) => error instanceof TrialEligibilityError && error.reason_codes.includes("verified_contact_required"));
await assert.rejects(() => claimTrial(tenantD, campaignKey, actor()), (error: unknown) => error instanceof TrialEligibilityError && error.outcome === "review");

const initialEnd = new Date(claimed[0].ends_at).getTime();
const extended = await extendTrial(tenantA, entitlementId, 2, "synthetic support extension", actor());
assert.equal(new Date(extended.ends_at).getTime() - initialEnd, 2 * 86_400_000);
const expired = await transitionTrial(tenantA, entitlementId, "expired", "synthetic expiry validation", actor());
assert.equal(expired.status, "expired");
assert.equal((await transitionTrial(tenantA, entitlementId, "expired", "idempotent replay", actor())).status, "expired");
await assert.rejects(() => transitionTrial(tenantB, entitlementId, "revoked", "cross tenant", actor()), TrialStateError);
assert.equal((await claimTrial(tenantA, campaignKey, actor())).status, "expired");

const afterCny = await ledgerBalances(tenantA, "CNY");
const afterAic = await ledgerBalances(tenantA, "AIC");
assert.deepEqual(afterCny.accounts, beforeCny.accounts);
assert.deepEqual(afterAic.accounts, beforeAic.accounts);
const history = await pool.query<{ adjustments: string; decisions: string; reversals: string }>(
  `SELECT (SELECT COUNT(*)::text FROM trial_adjustments WHERE tenant_id=$1) adjustments,
          (SELECT COUNT(*)::text FROM trial_eligibility_decisions WHERE tenant_id=ANY($2::text[])) decisions,
          (SELECT COUNT(*)::text FROM ledger_transactions WHERE tenant_id=$1 AND transaction_type='reversal' AND source_type='ledger_reversal') reversals`,
  [tenantA, [tenantA, tenantB, tenantC, tenantD]]
);
assert.deepEqual(history.rows[0], { adjustments: "2", decisions: "4", reversals: "2" });
await assert.rejects(() => pool.query(`UPDATE trial_eligibility_decisions SET outcome='eligible' WHERE tenant_id=$1`, [tenantC]));
await assert.rejects(() => pool.query(`DELETE FROM trial_adjustments WHERE tenant_id=$1`, [tenantA]));
await assert.rejects(() => pool.query(`UPDATE growth_campaigns SET benefit_rule=jsonb_set(benefit_rule,'{trial_days}','30') WHERE campaign_key=$1 AND status='active'`, [campaignKey]));

const overview = await getTrialOverview(tenantA);
assert.equal(overview.entitlement?.status, "expired");
console.log(`phase_b2_e2e=ok marker=${marker} concurrent=12 entitlement_once=true grants=2 reversals=2 verified_contact=true shared_admin_rejected=true unverified_rejected=true review_held=true extension_audited=true append_only=true campaign_immutable=true cross_tenant=true net_balance_unchanged=true`);
await pool.end();
