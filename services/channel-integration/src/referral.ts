import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./database.js";
import { inviterEligibility, normalizeInviteCode, paymentQualification, validateReferralRules } from "./referral-core.js";
import { assessMaturedReferral, issueReferralRewards, reverseReferralRewards } from "./referral-risk.js";
import {currentGrowthPolicy} from './growth-policy.js';
import {lockReferralPartner,readReferralPartner,referralPartnerEnabled} from './referral-partner-access.js';
import {currentInviterRules} from './referral-threshold.js';

export class ReferralEligibilityError extends Error { constructor(public reason_codes: string[]) { super(reason_codes.join(",")); } }
export class ReferralConflictError extends Error {}
export class ReferralNotFoundError extends Error {}
export type ReferralActor = { actor_type: "platform_user" | "internal_service"; actor_id: string; request_id: string };
type Campaign = { campaign_id: string; campaign_key: string; version: number; name: string; qualification_rule: unknown; benefit_rule: unknown; starts_at: Date; ends_at: Date };

async function getCampaign(client: PoolClient, now = new Date(), lock = false) {
  const result = await client.query<Campaign>(
    `SELECT campaign_id,campaign_key,version,name,qualification_rule,benefit_rule,starts_at,ends_at
       FROM growth_campaigns WHERE campaign_key='tenant-referral-cn' AND campaign_type='referral' AND status='active'
        AND starts_at<=$1 AND ends_at>$1 ORDER BY version DESC LIMIT 1${lock ? " FOR SHARE" : ""}`, [now]
  );
  return result.rows[0];
}

async function inviterFacts(client: PoolClient, tenantId: string) {
  const result = await client.query<{ billing_status: string; lifetime_cash_paid_minor: string; account_age_days: string; risk_restricted: boolean;tenant_active:boolean;tenant_name:string }>(
    `SELECT t.name tenant_name,(t.status='active') tenant_active,COALESCE(p.billing_status,'free') billing_status,COALESCE(p.lifetime_cash_paid_minor,0)::text lifetime_cash_paid_minor,
            GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (NOW()-t.created_at))/86400))::text account_age_days,
            (COALESCE(p.billing_status,'free')='risk_restricted' OR COALESCE(s.risk_state,'clear')='blocked') risk_restricted
       FROM tenants t LEFT JOIN tenant_commercial_profiles p ON p.tenant_id=t.tenant_id
       LEFT JOIN tenant_trial_signals s ON s.tenant_id=t.tenant_id WHERE t.tenant_id=$1`, [tenantId]
  );
  const row = result.rows[0];
  if (!row) throw new ReferralNotFoundError("tenant not found");
  const consumed=Number((await client.query(`SELECT COALESCE(SUM(p.cash_minor),0)::text AS total FROM wallet_purchases p WHERE p.tenant_id=$1 AND NOT EXISTS(SELECT 1 FROM wallet_requests r WHERE r.purchase_id=p.purchase_id AND r.status='paid')`,[tenantId])).rows[0].total);
  return { billing_status: row.risk_restricted?row.billing_status:consumed>0?'paid':row.billing_status, lifetime_cash_paid_minor: Math.max(Number(row.lifetime_cash_paid_minor),consumed), account_age_days: Number(row.account_age_days), risk_restricted: row.risk_restricted,tenant_active:row.tenant_active,tenant_name:row.tenant_name };
}

export async function referralPartnerOverview(tenantId:string){
 const c=await pool.connect();try{
  const campaign=await getCampaign(c),facts=await inviterFacts(c,tenantId),partner=await readReferralPartner(tenantId,c);
  const rules=campaign?await currentInviterRules(c,campaign.qualification_rule):null;
  return {feature_enabled:referralPartnerEnabled(),tenant_id:tenantId,partner,facts,campaign:campaign?{name:campaign.name,version:campaign.version,rules}:null,
   standard_eligibility:rules?inviterEligibility(facts,rules):null,effective_eligibility:rules?inviterEligibility(facts,rules,partner.enabled):null};
 }finally{c.release();}
}

export async function referralOverview(tenantId: string, includeHistory = true) {
  const client = await pool.connect();
  try {
    const campaign = await getCampaign(client);
    if (!campaign) return { campaign: null, inviter_eligibility: null, invite_code: null, statistics: { attributed: 0, pending: 0, review: 0, qualified: 0, rejected: 0, revoked: 0 } };
    const rules = await currentInviterRules(client,campaign.qualification_rule);
    const eligibility = inviterEligibility(await inviterFacts(client, tenantId), rules,(await readReferralPartner(tenantId,client)).enabled);
    const [code, stats] = await Promise.all([
      client.query(`SELECT invite_code,created_at FROM referral_invite_codes WHERE campaign_key=$1 AND inviter_tenant_id=$2 AND status='active'`, [campaign.campaign_key, tenantId]),
      client.query<{ status: string; count: string }>(`SELECT status,COUNT(*)::text count FROM referrals WHERE inviter_tenant_id=$1 AND campaign_key=$2 GROUP BY status`, [tenantId, campaign.campaign_key]),
    ]);
    const statistics: Record<string, number> = { attributed: 0, pending: 0, review: 0, qualified: 0, rejected: 0, revoked: 0 };
    for (const row of stats.rows) statistics[row.status] = Number(row.count);
    return {
      campaign: { campaign_key: campaign.campaign_key, version: campaign.version, name: campaign.name, starts_at: campaign.starts_at, ends_at: campaign.ends_at, qualification_rule: rules },
      growth_policy: (await currentGrowthPolicy(client)).rules,
      commissions: includeHistory ? (await client.query(`SELECT commission_id,payment_kind,cash_minor,rate_bps,amount_minor,retained_minor,status,matures_at,created_at FROM plan_commissions WHERE inviter_tenant_id=$1 ORDER BY created_at DESC LIMIT 100`,[tenantId])).rows : [],
      inviter_eligibility: eligibility, invite_code: code.rows[0] ?? null, statistics,
    };
  } finally { client.release(); }
}

export async function createOrGetInviteCode(tenantId: string, inviterUserId: string, actor: ReferralActor) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`referral-code:${tenantId}`]);
    await lockReferralPartner(client,tenantId);
    const campaign = await getCampaign(client, new Date(), true);
    if (!campaign) throw new ReferralNotFoundError("referral campaign not available");
    const membership = await client.query(`SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND platform_user_id=$2 AND role='tenant_admin' AND status='active'`, [tenantId, inviterUserId]);
    if (!membership.rowCount) throw new ReferralEligibilityError(["tenant_admin_required"]);
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('growth-policy-publish'))");
    const eligibility = inviterEligibility(await inviterFacts(client, tenantId), await currentInviterRules(client,campaign.qualification_rule),(await readReferralPartner(tenantId,client)).enabled);
    if (!eligibility.eligible) throw new ReferralEligibilityError(eligibility.reason_codes);
    const existing = await client.query(`SELECT invite_code_id,invite_code,created_at FROM referral_invite_codes WHERE campaign_key=$1 AND inviter_tenant_id=$2 AND status='active' FOR UPDATE`, [campaign.campaign_key, tenantId]);
    if (existing.rows[0]) { await client.query("COMMIT"); return { ...existing.rows[0], idempotent_replay: true }; }
    const code = randomBytes(18).toString("base64url");
    const inserted = await client.query(
      `INSERT INTO referral_invite_codes(campaign_id,campaign_key,campaign_version,inviter_tenant_id,inviter_user_id,invite_code)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING invite_code_id,invite_code,created_at`,
      [campaign.campaign_id, campaign.campaign_key, campaign.version, tenantId, inviterUserId, code]
    );
    await client.query(
      `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
       VALUES($1,$2,$3,'referral.invite_code_created','referral_invite_code',$4,jsonb_build_object('campaign_key',$5::text,'campaign_version',$6::int),$7)`,
      [tenantId, actor.actor_type, actor.actor_id, inserted.rows[0].invite_code_id, campaign.campaign_key, campaign.version, actor.request_id]
    );
    await client.query("COMMIT");
    return { ...inserted.rows[0], idempotent_replay: false };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

async function statusEvent(client: PoolClient, row: Record<string, unknown>, fromStatus: string | null, toStatus: string, reasons: string[], actor: ReferralActor) {
  await client.query(
    `INSERT INTO referral_status_events(referral_id,tenant_id,from_status,to_status,reason_codes,actor_type,actor_id,request_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [row.referral_id, row.inviter_tenant_id, fromStatus, toStatus, reasons, actor.actor_type, actor.actor_id, actor.request_id]
  );
}

export async function attributeReferral(rawCode: unknown, inviteeTenantId: string, inviteeUserId: string, actor: ReferralActor, now = new Date()) {
  const code = normalizeInviteCode(rawCode);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`referral-attribution:${inviteeTenantId}`]);
    const existing = await client.query(`SELECT * FROM referrals WHERE invitee_tenant_id=$1 FOR UPDATE`, [inviteeTenantId]);
    if (existing.rows[0]) {
      const used = await client.query(`SELECT invite_code FROM referral_invite_codes WHERE invite_code_id=$1`, [existing.rows[0].invite_code_id]);
      if (used.rows[0]?.invite_code !== code) throw new ReferralConflictError("first valid attribution is already locked");
      await client.query("COMMIT"); return { ...existing.rows[0], idempotent_replay: true };
    }
    const source = await client.query<Campaign & { invite_code_id: string; inviter_tenant_id: string; inviter_user_id: string; code_created_at: Date; status: string }>(
      `SELECT c.campaign_id,c.campaign_key,c.version,c.name,c.qualification_rule,c.benefit_rule,c.starts_at,c.ends_at,
              i.invite_code_id,i.inviter_tenant_id,i.inviter_user_id,i.created_at code_created_at,i.status
         FROM referral_invite_codes i JOIN growth_campaigns c ON c.campaign_id=i.campaign_id
        WHERE i.invite_code=$1 AND i.status='active' AND c.status='active' AND c.starts_at<=$2 AND c.ends_at>$2`, [code, now]
    );
    const invite = source.rows[0];
    if (!invite) throw new ReferralNotFoundError("invite code not available");
    if (invite.inviter_tenant_id === inviteeTenantId || invite.inviter_user_id === inviteeUserId) throw new ReferralEligibilityError(["self_invitation"]);
    const rules = validateReferralRules(invite.qualification_rule);
    // A saved link is not a permanent eligibility bypass. Serialize with partner changes;
    // turning the exception off blocks new attributions when ordinary rules are unmet.
    await lockReferralPartner(client,invite.inviter_tenant_id);
    const stillActive=await client.query(`SELECT 1 FROM referral_invite_codes i JOIN growth_campaigns c ON c.campaign_id=i.campaign_id
      WHERE i.invite_code_id=$1 AND i.status='active' AND c.status='active' AND c.starts_at<=$2 AND c.ends_at>$2 FOR SHARE`,[invite.invite_code_id,now]);
    if(!stillActive.rowCount)throw new ReferralNotFoundError('invite code not available');
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('growth-policy-publish'))");
    const inviter=inviterEligibility(await inviterFacts(client,invite.inviter_tenant_id),await currentInviterRules(client,invite.qualification_rule),(await readReferralPartner(invite.inviter_tenant_id,client)).enabled);
    if(!inviter.eligible)throw new ReferralEligibilityError(inviter.reason_codes);
    const invitee = await client.query<{ created_at: Date }>(
      `SELECT t.created_at FROM tenants t JOIN tenant_memberships m ON m.tenant_id=t.tenant_id
        WHERE t.tenant_id=$1 AND m.platform_user_id=$2 AND m.role='tenant_admin' AND m.status='active' FOR SHARE OF t`, [inviteeTenantId, inviteeUserId]
    );
    if (!invitee.rows[0]) throw new ReferralEligibilityError(["invitee_admin_required"]);
    const createdAt = invitee.rows[0].created_at;
    if (createdAt < invite.code_created_at || now.getTime() - createdAt.getTime() > rules.attribution_window_minutes * 60_000) {
      throw new ReferralEligibilityError(["attribution_window_closed"]);
    }
    const inserted = await client.query(
      `INSERT INTO referrals(campaign_id,campaign_key,campaign_version,invite_code_id,inviter_tenant_id,inviter_user_id,invitee_tenant_id,invitee_user_id,growth_policy_version)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [invite.campaign_id, invite.campaign_key, invite.version, invite.invite_code_id, invite.inviter_tenant_id, invite.inviter_user_id, inviteeTenantId, inviteeUserId,(await currentGrowthPolicy(client)).version]
    );
    await statusEvent(client, inserted.rows[0], null, "attributed", ["first_valid_attribution"], actor);
    await client.query(
      `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
       VALUES($1,$2,$3,'referral.attributed','referral',$4,jsonb_build_object('campaign_key',$5::text,'campaign_version',$6::int),$7)`,
      [inviteeTenantId, actor.actor_type, actor.actor_id, inserted.rows[0].referral_id, invite.campaign_key, invite.version, actor.request_id]
    );
    await client.query("COMMIT");
    return { ...inserted.rows[0], idempotent_replay: false };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export type ReferralPaymentEvent = { source_type: string; source_id: string; cash_paid_minor: number; currency: string; occurred_at: string; metadata?: Record<string, unknown> };
function validatePaymentEvent(input: ReferralPaymentEvent) {
  if (!input.source_type?.trim() || input.source_type.length > 64 || !input.source_id?.trim() || input.source_id.length > 200 || !Number.isFinite(Date.parse(input.occurred_at))) throw new Error("invalid referral payment event");
  if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata) || Buffer.byteLength(JSON.stringify(input.metadata)) > 4096) input.metadata = {};
}

export async function recordReferralPayment(referralId: string, input: ReferralPaymentEvent, actor: ReferralActor) {
  validatePaymentEvent(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(`SELECT r.*,c.qualification_rule FROM referrals r JOIN growth_campaigns c ON c.campaign_id=r.campaign_id WHERE r.referral_id=$1 FOR UPDATE OF r`, [referralId]);
    const row = current.rows[0];
    if (!row) throw new ReferralNotFoundError("referral not found");
    const replay = await client.query(`SELECT event_id FROM referral_qualification_events WHERE source_type=$1 AND source_id=$2 AND event_type='payment_settled'`, [input.source_type, input.source_id]);
    if (replay.rows[0]) { await client.query("COMMIT"); return row; }
    if (row.status !== "attributed") throw new ReferralConflictError("referral no longer accepts a first payment");
    const rules = validateReferralRules(row.qualification_rule);
    const decision = paymentQualification(input.cash_paid_minor, input.currency, new Date(input.occurred_at), rules);
    const event = await client.query<{ event_id: string }>(
      `INSERT INTO referral_qualification_events(referral_id,invitee_tenant_id,event_type,source_type,source_id,cash_paid_minor,currency,occurred_at,metadata,created_by)
       VALUES($1,$2,'payment_settled',$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING event_id`,
      [referralId, row.invitee_tenant_id, input.source_type.trim(), input.source_id.trim(), input.cash_paid_minor, input.currency, input.occurred_at, JSON.stringify(input.metadata), actor.actor_id]
    );
    const nextStatus = decision.accepted ? "pending" : "rejected";
    const updated = await client.query(`UPDATE referrals SET status=$2,qualification_event_id=$3,observation_ends_at=$4,updated_at=NOW() WHERE referral_id=$1 RETURNING *`, [referralId, nextStatus, event.rows[0].event_id, decision.observation_ends_at]);
    await statusEvent(client, row, "attributed", nextStatus, decision.reason_codes, actor);
    await client.query("COMMIT"); return updated.rows[0];
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function invalidateReferralPayment(referralId: string, sourceType: string, sourceId: string, eventType: "payment_refunded" | "payment_chargeback" | "payment_invalidated", reason: string, actor: ReferralActor) {
  if (!sourceType.trim() || !sourceId.trim() || !reason.trim()) throw new Error("invalid referral invalidation");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(`SELECT * FROM referrals WHERE referral_id=$1 FOR UPDATE`, [referralId]);
    const row = current.rows[0];
    if (!row) throw new ReferralNotFoundError("referral not found");
    const replay = await client.query(`SELECT event_id FROM referral_qualification_events WHERE source_type=$1 AND source_id=$2 AND event_type=$3`, [sourceType, sourceId, eventType]);
    if (replay.rows[0]) {
      await client.query("COMMIT");
      if (row.status === "revoked") await reverseReferralRewards(referralId, actor, `referral ${eventType}: ${reason.trim()}`);
      return row;
    }
    if (!["pending", "qualified"].includes(row.status)) throw new ReferralConflictError("referral cannot be invalidated in its current state");
    await client.query(
      `INSERT INTO referral_qualification_events(referral_id,invitee_tenant_id,event_type,source_type,source_id,cash_paid_minor,currency,occurred_at,metadata,created_by)
       VALUES($1,$2,$3,$4,$5,0,'CNY',NOW(),jsonb_build_object('reason',$6::text),$7)`, [referralId, row.invitee_tenant_id, eventType, sourceType, sourceId, reason.slice(0, 500), actor.actor_id]
    );
    const nextStatus = row.status === "qualified" ? "revoked" : "rejected";
    const updated = await client.query(`UPDATE referrals SET status=$2,updated_at=NOW() WHERE referral_id=$1 RETURNING *`, [referralId, nextStatus]);
    await statusEvent(client, row, row.status, nextStatus, [eventType], actor);
    await client.query("COMMIT");
    if (nextStatus === "revoked") await reverseReferralRewards(referralId, actor, `referral ${eventType}: ${reason.trim()}`);
    return updated.rows[0];
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function qualifyMaturedReferrals(now = new Date(), actorId = "referral-observation-worker", onlyReferralId?: string, enforceRiskAndRewards = true) {
  const due = await pool.query<{ referral_id: string }>(`SELECT referral_id FROM referrals WHERE status='pending' AND observation_ends_at<=$1 AND ($2::uuid IS NULL OR referral_id=$2) ORDER BY observation_ends_at LIMIT 100`, [now, onlyReferralId ?? null]);
  let qualified = 0;
  for (const item of due.rows) {
    if (enforceRiskAndRewards) {
      const actor: ReferralActor = { actor_type: "internal_service", actor_id: actorId, request_id: randomUUID() };
      const updated = await assessMaturedReferral(item.referral_id, now, actor);
      if (updated?.status === "qualified") {
        qualified += 1;
        await issueReferralRewards(item.referral_id, actor);
      }
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(`SELECT * FROM referrals WHERE referral_id=$1 FOR UPDATE`, [item.referral_id]);
      const row = current.rows[0];
      if (!row || row.status !== "pending" || new Date(row.observation_ends_at) > now) { await client.query("ROLLBACK"); continue; }
      const updated = await client.query(`UPDATE referrals SET status='qualified',updated_at=NOW() WHERE referral_id=$1 RETURNING *`, [item.referral_id]);
      const actor: ReferralActor = { actor_type: "internal_service", actor_id: actorId, request_id: randomUUID() };
      await statusEvent(client, row, "pending", "qualified", ["observation_period_passed"], actor);
      await client.query("COMMIT");
      if (updated.rows[0]) qualified += 1;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }
  return qualified;
}
