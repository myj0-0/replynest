import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { postLedgerTransaction, reverseLedgerTransaction, type LedgerActor } from "./ledger.js";
import { decideTrialEligibility, trialWindow, validateTrialBenefit, type TrialBenefit, type TrialOutcome, type TrialSignals } from "./trial-core.js";

export class TrialNotAvailableError extends Error {}
export class TrialEligibilityError extends Error {
  constructor(public outcome: TrialOutcome, public reason_codes: string[]) { super(`trial ${outcome}: ${reason_codes.join(",")}`); }
}
export class TrialStateError extends Error {}

export type TrialActor = LedgerActor & { actor_type: "platform_user" | "internal_service" };
type CampaignRow = { campaign_id: string; campaign_key: string; version: number; name: string; starts_at: Date; ends_at: Date; qualification_rule: Record<string, unknown>; benefit_rule: unknown };

function validCampaignKey(value: string) {
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value)) throw new TrialNotAvailableError("trial campaign not available");
  return value;
}

async function activeCampaign(client: PoolClient, campaignKey: string, now: Date, lock = false) {
  const result = await client.query<CampaignRow>(
    `SELECT campaign_id,campaign_key,version,name,starts_at,ends_at,qualification_rule,benefit_rule
       FROM growth_campaigns WHERE campaign_key=$1 AND campaign_type='trial' AND status='active'
        AND starts_at<=$2 AND ends_at>$2 ORDER BY version DESC LIMIT 1${lock ? " FOR SHARE" : ""}`,
    [campaignKey, now]
  );
  return result.rows[0];
}

async function entitlementFor(client: PoolClient, tenantId: string, campaignKey: string, lock = false) {
  const result = await client.query(
    `SELECT entitlement_id,tenant_id,campaign_id,campaign_key,campaign_version,status,starts_at,ends_at,grace_ends_at,
            benefit_snapshot,ledger_transaction_ids,created_at,updated_at
       FROM trial_entitlements WHERE tenant_id=$1 AND campaign_key=$2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, campaignKey]
  );
  return result.rows[0];
}

async function collectSignals(client: PoolClient, tenantId: string, campaignKey: string): Promise<TrialSignals & { risk_reason_codes: string[] }> {
  const result = await client.query<{
    has_verified_contact: boolean; prior_trial: boolean; shared_admin: boolean; shared_verified_phone: boolean;
    shared_organization: boolean; risk_state: "clear" | "review" | "blocked"; risk_reason_codes: string[];
  }>(
    `SELECT
       EXISTS(SELECT 1 FROM tenant_memberships m JOIN platform_users u ON u.platform_user_id=m.platform_user_id
               WHERE m.tenant_id=$1 AND m.status='active' AND m.role='tenant_admin' AND u.status='active'
                 AND (u.email_verified_at IS NOT NULL OR u.phone_verified_at IS NOT NULL)) AS has_verified_contact,
       EXISTS(SELECT 1 FROM trial_entitlements e WHERE e.tenant_id=$1 AND e.campaign_key=$2) AS prior_trial,
       EXISTS(SELECT 1 FROM tenant_memberships mine JOIN tenant_memberships other ON other.platform_user_id=mine.platform_user_id AND other.tenant_id<>mine.tenant_id
               JOIN trial_entitlements e ON e.tenant_id=other.tenant_id AND e.campaign_key=$2
               WHERE mine.tenant_id=$1 AND mine.status='active' AND mine.role='tenant_admin' AND other.status='active') AS shared_admin,
       EXISTS(SELECT 1 FROM tenant_memberships mine JOIN platform_users u ON u.platform_user_id=mine.platform_user_id AND u.phone_verified_at IS NOT NULL
               JOIN platform_users ou ON ou.phone_e164=u.phone_e164 AND ou.phone_verified_at IS NOT NULL
               JOIN tenant_memberships other ON other.platform_user_id=ou.platform_user_id AND other.tenant_id<>mine.tenant_id
               JOIN trial_entitlements e ON e.tenant_id=other.tenant_id AND e.campaign_key=$2
               WHERE mine.tenant_id=$1 AND mine.status='active' AND mine.role='tenant_admin' AND other.status='active') AS shared_verified_phone,
       EXISTS(SELECT 1 FROM tenant_trial_signals mine JOIN tenant_trial_signals other
               ON other.organization_fingerprint_hash=mine.organization_fingerprint_hash AND other.tenant_id<>mine.tenant_id
               JOIN trial_entitlements e ON e.tenant_id=other.tenant_id AND e.campaign_key=$2
               WHERE mine.tenant_id=$1 AND mine.organization_fingerprint_hash IS NOT NULL) AS shared_organization,
       COALESCE((SELECT risk_state FROM tenant_trial_signals WHERE tenant_id=$1),'clear') AS risk_state,
       COALESCE((SELECT risk_reason_codes FROM tenant_trial_signals WHERE tenant_id=$1),'{}'::text[]) AS risk_reason_codes`,
    [tenantId, campaignKey]
  );
  return result.rows[0];
}

function publicCampaign(campaign: CampaignRow | undefined) {
  if (!campaign) return null;
  return { campaign_key: campaign.campaign_key, version: campaign.version, name: campaign.name, starts_at: campaign.starts_at, ends_at: campaign.ends_at, benefit: validateTrialBenefit(campaign.benefit_rule) };
}

export async function getTrialOverview(tenantId: string, campaignKey = "professional-trial-cn", now = new Date()) {
  validCampaignKey(campaignKey);
  const client = await pool.connect();
  try {
    const [campaign, entitlement] = await Promise.all([activeCampaign(client, campaignKey, now), entitlementFor(client, tenantId, campaignKey)]);
    let eligibility: { outcome: TrialOutcome; reason_codes: string[] } | null = null;
    if (!entitlement && campaign) eligibility = decideTrialEligibility(await collectSignals(client, tenantId, campaignKey));
    return { campaign: publicCampaign(campaign), eligibility, entitlement: entitlement ?? null, server_time: now.toISOString() };
  } finally { client.release(); }
}

async function provisionEntitlement(entitlement: Record<string, unknown>, actor: TrialActor) {
  const entitlementId = String(entitlement.entitlement_id);
  const tenantId = String(entitlement.tenant_id);
  const benefit = validateTrialBenefit(entitlement.benefit_snapshot);
  const startsAt = new Date(String(entitlement.starts_at)).toISOString();
  const endsAt = new Date(String(entitlement.ends_at)).toISOString();
  const transactionIds: string[] = [];
  for (const grant of [...benefit.grants].sort((a, b) => `${a.currency}:${a.account}`.localeCompare(`${b.currency}:${b.account}`))) {
    const posted = await postLedgerTransaction(tenantId, {
      transaction_type: grant.account === "ai_credit" ? "ai_credit_grant" : "gift_grant",
      currency: grant.currency, idempotency_key: `trial:${entitlementId}:grant:${grant.currency}:${grant.account}`,
      source_type: "trial_entitlement", source_id: entitlementId, occurred_at: startsAt,
      metadata: { campaign_key: entitlement.campaign_key, campaign_version: entitlement.campaign_version, entitlement_id: entitlementId },
      entries: [
        { account: "clearing", direction: "debit", amount_minor: grant.amount_minor },
        { account: grant.account, direction: "credit", amount_minor: grant.amount_minor, expires_at: endsAt },
      ],
    }, actor);
    transactionIds.push(String(posted.transaction_id));
  }
  const updated = await pool.query(
    `UPDATE trial_entitlements SET status='active',ledger_transaction_ids=$2::jsonb,updated_at=NOW()
      WHERE entitlement_id=$1 AND status='provisioning' RETURNING *`, [entitlementId, JSON.stringify(transactionIds)]
  );
  if (updated.rows[0]) {
    await pool.query(
      `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
       VALUES($1,$2,$3,'trial.claimed','trial_entitlement',$4,jsonb_build_object('campaign_key',$5::text,'campaign_version',$6::int,'ledger_transaction_ids',$7::jsonb),$8)`,
      [tenantId, actor.actor_type, actor.actor_id, entitlementId, entitlement.campaign_key, entitlement.campaign_version, JSON.stringify(transactionIds), actor.request_id]
    );
  }
  return updated.rows[0] ?? (await pool.query(`SELECT * FROM trial_entitlements WHERE entitlement_id=$1`, [entitlementId])).rows[0];
}

export async function claimTrial(tenantId: string, campaignKey: string, actor: TrialActor, now = new Date()) {
  validCampaignKey(campaignKey);
  const client = await pool.connect();
  let entitlement: Record<string, unknown> | undefined;
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`trial:${tenantId}:${campaignKey}`]);
    const existing = await entitlementFor(client, tenantId, campaignKey, true);
    if (existing) {
      entitlement = existing;
      await client.query("COMMIT");
    } else {
      const campaign = await activeCampaign(client, campaignKey, now, true);
      if (!campaign) throw new TrialNotAvailableError("trial campaign not available");
      const signals = await collectSignals(client, tenantId, campaignKey);
      const decision = decideTrialEligibility(signals);
      const inserted = await client.query<{ decision_id: string }>(
        `INSERT INTO trial_eligibility_decisions
          (tenant_id,campaign_id,campaign_key,campaign_version,outcome,reason_codes,signal_snapshot,actor_type,actor_id,request_id)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) RETURNING decision_id`,
        [tenantId, campaign.campaign_id, campaignKey, campaign.version, decision.outcome, decision.reason_codes, JSON.stringify(signals), actor.actor_type, actor.actor_id, actor.request_id]
      );
      await client.query(
        `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
         VALUES($1,$2,$3,'trial.eligibility_decided','trial_eligibility_decision',$4,jsonb_build_object('outcome',$5::text,'reason_codes',$6::text[],'campaign_version',$7::int),$8)`,
        [tenantId, actor.actor_type, actor.actor_id, inserted.rows[0].decision_id, decision.outcome, decision.reason_codes, campaign.version, actor.request_id]
      );
      if (decision.outcome !== "eligible") {
        await client.query("COMMIT");
        throw new TrialEligibilityError(decision.outcome, decision.reason_codes);
      }
      const benefit = validateTrialBenefit(campaign.benefit_rule);
      const window = trialWindow(now, benefit);
      const created = await client.query(
        `INSERT INTO trial_entitlements
          (tenant_id,campaign_id,campaign_key,campaign_version,decision_id,status,starts_at,ends_at,grace_ends_at,benefit_snapshot,created_by)
         VALUES($1,$2,$3,$4,$5,'provisioning',$6,$7,$8,$9::jsonb,$10) RETURNING *`,
        [tenantId, campaign.campaign_id, campaignKey, campaign.version, inserted.rows[0].decision_id, window.starts_at, window.ends_at, window.grace_ends_at, JSON.stringify(benefit), actor.actor_id]
      );
      entitlement = created.rows[0];
      await client.query("COMMIT");
    }
  } catch (error) {
    if (!(error instanceof TrialEligibilityError)) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
  if (!entitlement) throw new TrialStateError("trial entitlement was not created");
  if (entitlement.status === "provisioning") return provisionEntitlement(entitlement, actor);
  return entitlement;
}

export async function extendTrial(tenantId: string, entitlementId: string, days: number, reason: string, actor: TrialActor) {
  if (!Number.isInteger(days) || days < 1 || days > 90 || !reason.trim() || reason.length > 500) throw new TrialStateError("invalid trial extension");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(`SELECT * FROM trial_entitlements WHERE tenant_id=$1 AND entitlement_id=$2 FOR UPDATE`, [tenantId, entitlementId]);
    const row = current.rows[0];
    if (!row || row.status !== "active") throw new TrialStateError("only active trials can be extended");
    const nextEnd = new Date(new Date(row.ends_at).getTime() + days * 86_400_000);
    const nextGrace = new Date(new Date(row.grace_ends_at).getTime() + days * 86_400_000);
    const updated = await client.query(`UPDATE trial_entitlements SET ends_at=$3,grace_ends_at=$4,updated_at=NOW() WHERE tenant_id=$1 AND entitlement_id=$2 RETURNING *`, [tenantId, entitlementId, nextEnd, nextGrace]);
    await recordAdjustment(client, row, updated.rows[0], "extended", reason, actor);
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function recordAdjustment(client: PoolClient, before: Record<string, unknown>, after: Record<string, unknown>, action: "extended" | "expired" | "revoked" | "converted", reason: string, actor: TrialActor) {
  const snapshot = (row: Record<string, unknown>) => ({ status: row.status, starts_at: row.starts_at, ends_at: row.ends_at, grace_ends_at: row.grace_ends_at });
  await client.query(
    `INSERT INTO trial_adjustments(entitlement_id,tenant_id,action,reason,before_data,after_data,actor_type,actor_id,request_id)
     VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)`,
    [before.entitlement_id, before.tenant_id, action, reason.trim(), JSON.stringify(snapshot(before)), JSON.stringify(snapshot(after)), actor.actor_type, actor.actor_id, actor.request_id]
  );
  await client.query(
    `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,reason,before_data,after_data,request_id)
     VALUES($1,$2,$3,$4,'trial_entitlement',$5,$6,$7::jsonb,$8::jsonb,$9)`,
    [before.tenant_id, actor.actor_type, actor.actor_id, `trial.${action}`, before.entitlement_id, reason.trim(), JSON.stringify(snapshot(before)), JSON.stringify(snapshot(after)), actor.request_id]
  );
}

export async function transitionTrial(tenantId: string, entitlementId: string, action: "expired" | "revoked" | "converted", reason: string, actor: TrialActor) {
  if (!reason.trim() || reason.length > 500) throw new TrialStateError("trial transition reason is required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(`SELECT * FROM trial_entitlements WHERE tenant_id=$1 AND entitlement_id=$2 FOR UPDATE`, [tenantId, entitlementId]);
    const row = current.rows[0];
    if (!row) throw new TrialStateError("trial entitlement not found");
    if (row.status === action) { await client.query("COMMIT"); return row; }
    if (row.status !== "active") throw new TrialStateError("only active trials can transition");
    if (action !== "converted") {
      for (const transactionId of row.ledger_transaction_ids as string[]) {
        await reverseLedgerTransaction(tenantId, transactionId, `trial:${entitlementId}:${action}:${transactionId}`, `trial ${action}: ${reason.trim()}`, actor);
      }
    }
    const updated = await client.query(`UPDATE trial_entitlements SET status=$3,updated_at=NOW() WHERE tenant_id=$1 AND entitlement_id=$2 RETURNING *`, [tenantId, entitlementId, action]);
    await recordAdjustment(client, row, updated.rows[0], action, reason, actor);
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function expireDueTrials(now = new Date(), actorId = "trial-expiry-worker") {
  const due = await pool.query<{ tenant_id: string; entitlement_id: string }>(`SELECT tenant_id,entitlement_id FROM trial_entitlements WHERE status='active' AND ends_at<=$1 ORDER BY ends_at LIMIT 100`, [now]);
  for (const row of due.rows) await transitionTrial(row.tenant_id, row.entitlement_id, "expired", "configured trial period ended", { actor_type: "internal_service", actor_id: actorId, request_id: randomUUID() });
  return due.rowCount ?? 0;
}
