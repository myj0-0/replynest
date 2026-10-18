import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { postLedgerTransaction, reverseLedgerTransaction } from "./ledger.js";
import { assessReferralRisk, riskSignalFingerprint, signalConfidence, type RiskSignalType } from "./referral-risk-core.js";
import { secretValue } from "./secret-value.js";
import type { ReferralActor } from "./referral.js";

function pepper() {
  const value = secretValue("RISK_SIGNAL_PEPPER");
  if (!value || value.length < 32) throw new Error("risk signal pepper is not configured");
  return value;
}

export async function recordTenantRiskSignal(tenantId: string, signalType: RiskSignalType, rawValue: unknown, source: string, actorId: string) {
  if (!source.trim() || source.length > 64 || !actorId.trim()) throw new Error("invalid risk signal provenance");
  const fingerprint = riskSignalFingerprint(signalType, rawValue, pepper());
  const result = await pool.query(
    `INSERT INTO tenant_risk_signals(tenant_id,signal_type,fingerprint_hash,confidence,source,verified_at,created_by)
     VALUES($1,$2,$3,$4,$5,NOW(),$6)
     ON CONFLICT(tenant_id,signal_type,fingerprint_hash) DO NOTHING RETURNING signal_id,signal_type,confidence,created_at`,
    [tenantId, signalType, fingerprint, signalConfidence(signalType), source.trim(), actorId]
  );
  if (result.rows[0]) return { ...result.rows[0], idempotent_replay: false };
  const existing = await pool.query(`SELECT signal_id,signal_type,confidence,created_at FROM tenant_risk_signals WHERE tenant_id=$1 AND signal_type=$2 AND fingerprint_hash=$3`, [tenantId, signalType, fingerprint]);
  return { ...existing.rows[0], idempotent_replay: true };
}

export async function assessMaturedReferral(referralId: string, now: Date, actor: ReferralActor) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(`SELECT * FROM referrals WHERE referral_id=$1 FOR UPDATE`, [referralId]);
    const row = current.rows[0];
    if (!row || row.status !== "pending" || !row.observation_ends_at || new Date(row.observation_ends_at) > now) {
      await client.query("ROLLBACK"); return null;
    }
    const matches = await client.query<{ signal_type: RiskSignalType; confidence: "high" | "medium" | "low" }>(
      `SELECT DISTINCT mine.signal_type,mine.confidence
         FROM tenant_risk_signals mine JOIN tenant_risk_signals other
           ON other.signal_type=mine.signal_type AND other.fingerprint_hash=mine.fingerprint_hash AND other.tenant_id<>mine.tenant_id
        WHERE mine.tenant_id=$1 AND other.tenant_id=$2
          AND NOT EXISTS(SELECT 1 FROM tenant_risk_signal_revocations r WHERE r.signal_id=mine.signal_id)
          AND NOT EXISTS(SELECT 1 FROM tenant_risk_signal_revocations r WHERE r.signal_id=other.signal_id)`,
      [row.inviter_tenant_id, row.invitee_tenant_id]
    );
    const decision = assessReferralRisk(matches.rows);
    const version = await client.query<{ version: number }>(`SELECT COALESCE(MAX(assessment_version),0)+1 version FROM referral_risk_assessments WHERE referral_id=$1`, [referralId]);
    const assessment = await client.query<{ assessment_id: string }>(
      `INSERT INTO referral_risk_assessments(referral_id,assessment_version,outcome,risk_score,reason_codes,signal_snapshot,policy_version,actor_id)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,1,$7) RETURNING assessment_id`,
      [referralId, version.rows[0].version, decision.outcome, decision.risk_score, decision.reason_codes, JSON.stringify({ matched_signal_types: matches.rows.map(item => item.signal_type).sort(), raw_values_stored: false }), actor.actor_id]
    );
    const nextStatus = decision.outcome === "allow" ? "qualified" : decision.outcome === "review" ? "review" : "rejected";
    const updated = await client.query(
      `UPDATE referrals SET status=$2,risk_score=$3,risk_reasons=$4,risk_decision_id=$5,updated_at=NOW()
        WHERE referral_id=$1 RETURNING *`, [referralId, nextStatus, decision.risk_score, decision.reason_codes, assessment.rows[0].assessment_id]
    );
    await client.query(
      `INSERT INTO referral_status_events(referral_id,tenant_id,from_status,to_status,reason_codes,actor_type,actor_id,request_id)
       VALUES($1,$2,'pending',$3,$4,$5,$6,$7)`,
      [referralId, row.inviter_tenant_id, nextStatus, decision.reason_codes, actor.actor_type, actor.actor_id, actor.request_id]
    );
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

type Reward = { account: "referral" | "gift"; currency: string; amount_minor: number; expires_days: number };
function reward(raw: unknown, account: Reward["account"]): Reward {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid referral reward rule");
  const value = raw as Record<string, unknown>;
  const amount = Number(value.amount_minor), days = Number(value.expires_days), currency = String(value.currency ?? "");
  if (value.account !== account || !Number.isSafeInteger(amount) || amount <= 0 || !Number.isInteger(days) || days < 1 || days > 3650 || !/^[A-Z]{3}$/.test(currency)) throw new Error("invalid referral reward rule");
  return { account, currency, amount_minor: amount, expires_days: days };
}

export async function issueReferralRewards(referralId: string, actor: ReferralActor) {
  const facts = await pool.query(
    `SELECT r.*,c.benefit_rule,
       EXISTS(SELECT 1 FROM referral_risk_assessments a WHERE a.assessment_id=r.risk_decision_id AND a.outcome='allow') risk_allowed,
       EXISTS(SELECT 1 FROM referral_manual_reviews v WHERE v.referral_id=r.referral_id AND v.decision='approved') review_approved
       FROM referrals r JOIN growth_campaigns c ON c.campaign_id=r.campaign_id WHERE r.referral_id=$1`, [referralId]
  );
  const row = facts.rows[0];
  // New referrals use per-plan cash commissions and their own gift settlement.
  if (row?.growth_policy_version) return 0;
  if (!row || row.status !== "qualified" || (!row.risk_allowed && !row.review_approved)) return 0;
  const benefit = row.benefit_rule as Record<string, unknown>;
  const rewards = [
    { role: "inviter", tenantId: row.inviter_tenant_id, value: reward(benefit.inviter_reward, "referral") },
    { role: "invitee", tenantId: row.invitee_tenant_id, value: reward(benefit.invitee_reward, "gift") },
  ] as const;
  let posted = 0;
  for (const item of rewards) {
    const expiresAt = new Date(new Date(row.updated_at).getTime() + item.value.expires_days * 86_400_000).toISOString();
    await pool.query(
      `INSERT INTO referral_reward_grants(referral_id,beneficiary_tenant_id,beneficiary_role,account,currency,amount_minor,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(referral_id,beneficiary_role) DO NOTHING`,
      [referralId, item.tenantId, item.role, item.value.account, item.value.currency, item.value.amount_minor, expiresAt]
    );
    const grant = await pool.query(`SELECT * FROM referral_reward_grants WHERE referral_id=$1 AND beneficiary_role=$2`, [referralId, item.role]);
    if (grant.rows[0].status === "provisioning") {
      const ledger = await postLedgerTransaction(item.tenantId, {
        transaction_type: "referral_reward", currency: item.value.currency,
        idempotency_key: `referral:${referralId}:${item.role}`,
        source_type: "referral", source_id: referralId, occurred_at: new Date(row.updated_at).toISOString(),
        metadata: { campaign_key: row.campaign_key, campaign_version: row.campaign_version, beneficiary_role: item.role },
        entries: [
          { account: "clearing", direction: "debit", amount_minor: item.value.amount_minor },
          { account: item.value.account, direction: "credit", amount_minor: item.value.amount_minor, expires_at: expiresAt },
        ],
      }, actor);
      await pool.query(`UPDATE referral_reward_grants SET status='posted',ledger_transaction_id=$3,updated_at=NOW() WHERE referral_id=$1 AND beneficiary_role=$2 AND status='provisioning'`, [referralId, item.role, ledger.transaction_id]);
      posted += 1;
    }
  }
  return posted;
}

export async function reverseReferralRewards(referralId: string, actor: ReferralActor, reason: string) {
  const grants = await pool.query(`SELECT * FROM referral_reward_grants WHERE referral_id=$1 AND status='posted' ORDER BY beneficiary_role`, [referralId]);
  let reversed = 0;
  for (const grant of grants.rows) {
    const ledger = await reverseLedgerTransaction(grant.beneficiary_tenant_id, grant.ledger_transaction_id, `referral:${referralId}:${grant.beneficiary_role}:reversal`, reason, actor);
    await pool.query(`UPDATE referral_reward_grants SET status='reversed',reversal_transaction_id=$2,updated_at=NOW() WHERE grant_id=$1 AND status='posted'`, [grant.grant_id, ledger.transaction_id]);
    reversed += 1;
  }
  return reversed;
}

export async function reconcileReferralRewards(actorId = "referral-reward-worker") {
  const rows = await pool.query<{ referral_id: string; status: "qualified" | "revoked" }>(
    `SELECT r.referral_id,r.status FROM referrals r
        WHERE (r.growth_policy_version IS NULL AND r.status='qualified' AND ((SELECT COUNT(*) FROM referral_reward_grants g WHERE g.referral_id=r.referral_id AND g.status='posted')<2))
         OR (r.status='revoked' AND EXISTS(SELECT 1 FROM referral_reward_grants g WHERE g.referral_id=r.referral_id AND g.status='posted'))
      ORDER BY r.updated_at LIMIT 100`
  );
  let changed = 0;
  for (const row of rows.rows) {
    const actor: ReferralActor = { actor_type: "internal_service", actor_id: actorId, request_id: randomUUID() };
    changed += row.status === "qualified"
      ? await issueReferralRewards(row.referral_id, actor)
      : await reverseReferralRewards(row.referral_id, actor, "referral revoked; reconcile posted rewards");
  }
  return changed;
}

export async function reviewReferral(referralId: string, decision: "approved" | "rejected", reason: string, actor: ReferralActor) {
  if (!reason.trim() || reason.length > 500) throw new Error("manual review reason is required");
  const client = await pool.connect();
  let result: Record<string, unknown>;
  try {
    await client.query("BEGIN");
    const current = await client.query(`SELECT * FROM referrals WHERE referral_id=$1 FOR UPDATE`, [referralId]);
    const row = current.rows[0];
    if (!row || row.status !== "review" || !row.risk_decision_id) throw new Error("referral is not awaiting review");
    await client.query(
      `INSERT INTO referral_manual_reviews(referral_id,assessment_id,decision,reason,reviewer_id,request_id)
       VALUES($1,$2,$3,$4,$5,$6)`, [referralId, row.risk_decision_id, decision, reason.trim(), actor.actor_id, actor.request_id]
    );
    const status = decision === "approved" ? "qualified" : "rejected";
    const updated = await client.query(`UPDATE referrals SET status=$2,reviewed_by=$3,reviewed_at=NOW(),updated_at=NOW() WHERE referral_id=$1 RETURNING *`, [referralId, status, actor.actor_id]);
    await client.query(
      `INSERT INTO referral_status_events(referral_id,tenant_id,from_status,to_status,reason_codes,actor_type,actor_id,request_id)
       VALUES($1,$2,'review',$3,$4,$5,$6,$7)`, [referralId, row.inviter_tenant_id, status, [`manual_review_${decision}`], actor.actor_type, actor.actor_id, actor.request_id]
    );
    await client.query("COMMIT"); result = updated.rows[0];
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
  if (decision === "approved") await issueReferralRewards(referralId, actor);
  return result!;
}
