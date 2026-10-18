import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./database.js";
import {massCampaignOverview} from './mass-campaign-scheduler.js';
import {stageMassAudience} from './mass-campaign-planner.js';
import {recordMassReview} from './mass-campaign-store.js';
import { tenantCampaignAccess } from './campaign-access.js';
import {campaignExecutionAvailability} from './campaign-access-core.js';
import { campaignRecipientDecision, matchesCampaignAudience, nextCampaignAllowedAt, normalizeCampaignInput, normalizeCampaignSchedule, type CampaignAudienceFilter } from "./message-campaign-core.js";

export type CampaignActor = { actor_type: "console_session"; actor_id: string; request_id: string };
export class CampaignError extends Error { constructor(public code: string, public status = 400) { super(code); } }

export async function reviewMassCampaignBatch(tenantId:string,campaignId:string,batchId:string,reason:string,actor:CampaignActor){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const review=await recordMassReview(client,{tenantId,campaignId,batchId},actor.actor_id,reason);
  await client.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,reason,after_data,request_id)
   VALUES($1,$2,$3,'message_campaign.mass_reviewed','message_campaign',$4,$5,$6,$7)`,
   [tenantId,actor.actor_type,actor.actor_id,campaignId,reason.trim(),JSON.stringify({batch_id:batchId,...review,no_resend:true}),actor.request_id]);
  await client.query('COMMIT');return review;
 }catch(error){
  await client.query('ROLLBACK');
  if(error instanceof Error&&['mass_review_reason_required','mass_batch_not_found','mass_batch_not_reviewable'].includes(error.message))throw new CampaignError(error.message,error.message==='mass_batch_not_found'?404:409);
  throw error;
 }finally{client.release();}
}

async function requireCampaignAccess(client: PoolClient, tenantId: string, campaign: {channel:string;channel_connection_id?:string|null}) {
  // Mock campaigns never leave the synthetic transport. Real channels must be bound explicitly.
  if (campaign.channel === 'mock-wechat') return null;
  const access = await tenantCampaignAccess(tenantId, client);
  if (!access.eligible) throw new CampaignError(access.reason!, 403);
  if (campaign.channel_connection_id !== undefined && campaign.channel_connection_id !== access.connection_id) {
    throw new CampaignError('campaign_channel_changed_recreate_required', 409);
  }
  return access.connection_id;
}

function requestHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function eventAndAudit(client: PoolClient, tenantId: string, campaignId: string, eventType: string, actor: CampaignActor, facts: unknown, reason?: string) {
  await client.query(
    `INSERT INTO message_campaign_events(campaign_id,tenant_id,event_type,actor_type,actor_id,reason,facts,request_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [campaignId, tenantId, eventType, actor.actor_type, actor.actor_id, reason ?? null, JSON.stringify(facts), actor.request_id]
  );
  await client.query(
    `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,reason,after_data,request_id)
     VALUES($1,$2,$3,$4,'message_campaign',$5,$6,$7,$8)`,
    [tenantId, actor.actor_type, actor.actor_id, `message_campaign.${eventType}`, campaignId, reason ?? null, JSON.stringify(facts), actor.request_id]
  );
}

export async function listMessageCampaigns(tenantId: string) {
  const result = await pool.query(
    `SELECT c.campaign_id,c.name,c.channel,c.purpose,c.content,c.audience_filter,c.status,c.snapshot_at,
            c.audience_total,c.eligible_total,c.suppressed_total,c.approved_at,c.approval_reason,c.scheduled_at,c.timezone,
            c.quiet_hours_start,c.quiet_hours_end,c.rate_limit_per_minute,c.cancel_condition,c.started_at,c.completed_at,c.created_at,c.updated_at,
            COUNT(d.delivery_id)::int AS delivery_total,
            COUNT(d.delivery_id) FILTER(WHERE d.status='delivered')::int AS delivered_total,
            COUNT(d.delivery_id) FILTER(WHERE d.status='suppressed')::int AS execution_suppressed_total,
            COUNT(d.delivery_id) FILTER(WHERE d.status='dead')::int AS dead_total,
            COUNT(d.delivery_id) FILTER(WHERE d.status IN ('queued','retry_pending','processing'))::int AS pending_total
       FROM message_campaigns c LEFT JOIN message_campaign_deliveries d ON d.campaign_id=c.campaign_id
      WHERE c.tenant_id=$1 GROUP BY c.campaign_id ORDER BY c.created_at DESC LIMIT 50`, [tenantId]
  );
  const access = await tenantCampaignAccess(tenantId);
  return { ...campaignExecutionAvailability(access.eligible), access, data: result.rows };
}

export async function getMessageCampaignDeliveries(tenantId: string, campaignId: string, requestedStatus = "all", requestedLimit = 50) {
  const status = ['queued','processing','retry_pending','delivered','suppressed','dead','cancelled'].includes(requestedStatus) ? requestedStatus : "all";
  const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 50;
  const campaign = await pool.query(`SELECT campaign_id,name,status,channel FROM message_campaigns WHERE tenant_id=$1 AND campaign_id=$2`, [tenantId, campaignId]);
  if (!campaign.rows[0]) throw new CampaignError("campaign_not_found", 404);
  const deliveries = await pool.query(
    `SELECT d.delivery_id,'RN-'||upper(left(replace(d.delivery_id::text,'-',''),8)) AS recipient_ref,d.status,d.attempt_count,
            d.next_attempt_at,d.failure_code,d.suppression_reason,d.delivered_at,d.completed_at,d.updated_at
       FROM message_campaign_deliveries d WHERE d.tenant_id=$1 AND d.campaign_id=$2 AND ($3='all' OR d.status=$3)
      ORDER BY d.updated_at DESC,d.delivery_id LIMIT $4`, [tenantId, campaignId, status, limit]
  );
  const failures = await pool.query(
    `SELECT COALESCE(failure_code,suppression_reason,'none') AS reason,COUNT(*)::int count
       FROM message_campaign_deliveries WHERE tenant_id=$1 AND campaign_id=$2 AND status IN ('dead','suppressed')
      GROUP BY COALESCE(failure_code,suppression_reason,'none') ORDER BY count DESC,reason`, [tenantId, campaignId]
  );
  const mass = campaign.rows[0].channel==='wechat_official_account' ? await massCampaignOverview(pool,tenantId,campaignId) : null;
  return { campaign: campaign.rows[0], data: deliveries.rows, failure_distribution: failures.rows, pagination: { limit, status }, mass };
}

export async function pauseMessageCampaign(tenantId: string, campaignId: string, reason: string, actor: CampaignActor) {
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 10 || normalizedReason.length > 500) throw new CampaignError("pause_reason_required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(`UPDATE message_campaigns SET status='paused',updated_at=NOW() WHERE tenant_id=$1 AND campaign_id=$2 AND status IN ('scheduled','running') RETURNING *`, [tenantId, campaignId]);
    if (!updated.rows[0]) {
      const exists = await client.query(`SELECT 1 FROM message_campaigns WHERE tenant_id=$1 AND campaign_id=$2`, [tenantId, campaignId]);
      throw new CampaignError(exists.rows[0] ? "campaign_not_pausable" : "campaign_not_found", exists.rows[0] ? 409 : 404);
    }
    await eventAndAudit(client, tenantId, campaignId, "paused", actor, { previous_status: updated.rows[0].started_at ? "running" : "scheduled" }, normalizedReason);
    await client.query("COMMIT"); return updated.rows[0];
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function resumeMessageCampaign(tenantId: string, campaignId: string, reason: string, actor: CampaignActor) {
  if (process.env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED !== "true") throw new CampaignError("campaign_execution_disabled", 409);
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 10 || normalizedReason.length > 500) throw new CampaignError("resume_reason_required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(`SELECT * FROM message_campaigns WHERE tenant_id=$1 AND campaign_id=$2 FOR UPDATE`, [tenantId, campaignId]);
    if (!found.rows[0]) throw new CampaignError("campaign_not_found", 404);
    if (found.rows[0].status !== "paused") throw new CampaignError("campaign_not_resumable", 409);
    const provider=process.env.MESSAGE_CAMPAIGN_PROVIDER??'synthetic';
    const channel=found.rows[0].channel;
    if(!((channel==='mock-wechat'&&provider==='synthetic')||(channel==='wechat_official_account'&&provider==='wechat_mass'&&process.env.MASS_CAMPAIGN_SCHEDULING_ENABLED==='true')))throw new CampaignError('campaign_execution_disabled',409);
    await requireCampaignAccess(client, tenantId, found.rows[0]);
    const nextStatus = found.rows[0].started_at ? "running" : "scheduled";
    const updated = await client.query(`UPDATE message_campaigns SET status=$3,updated_at=NOW() WHERE tenant_id=$1 AND campaign_id=$2 RETURNING *`, [tenantId, campaignId, nextStatus]);
    await eventAndAudit(client, tenantId, campaignId, "resumed", actor, { resumed_to: nextStatus }, normalizedReason);
    await client.query("COMMIT"); return updated.rows[0];
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function retryMessageCampaignDelivery(tenantId: string, campaignId: string, deliveryId: string, reason: string, actor: CampaignActor, now = new Date()) {
  if (process.env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED !== "true" || (process.env.MESSAGE_CAMPAIGN_PROVIDER ?? "synthetic") !== "synthetic") throw new CampaignError("campaign_execution_disabled", 409);
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 10 || normalizedReason.length > 500) throw new CampaignError("retry_reason_required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const campaign = await client.query(`SELECT * FROM message_campaigns WHERE tenant_id=$1 AND campaign_id=$2 FOR UPDATE`, [tenantId, campaignId]);
    if (!campaign.rows[0]) throw new CampaignError("campaign_not_found", 404);
    if(campaign.rows[0].channel!=='mock-wechat')throw new CampaignError('mass_batch_retry_forbidden',409);
    if (campaign.rows[0].status !== "failed") throw new CampaignError("campaign_not_retryable", 409);
    await requireCampaignAccess(client, tenantId, campaign.rows[0]);
    const delivery = await client.query(`SELECT * FROM message_campaign_deliveries WHERE tenant_id=$1 AND campaign_id=$2 AND delivery_id=$3 FOR UPDATE`, [tenantId, campaignId, deliveryId]);
    if (!delivery.rows[0]) throw new CampaignError("campaign_delivery_not_found", 404);
    if (delivery.rows[0].status !== "dead" || Number(delivery.rows[0].attempt_count) >= 3) throw new CampaignError("campaign_delivery_not_retryable", 409);
    const next = new Date(Math.max(now.getTime() + 1000, new Date(delivery.rows[0].next_attempt_at).getTime() + 1));
    const updated = await client.query(`UPDATE message_campaign_deliveries SET status='retry_pending',next_attempt_at=$4,failure_code=NULL,completed_at=NULL,updated_at=$4 WHERE tenant_id=$1 AND campaign_id=$2 AND delivery_id=$3 RETURNING *`, [tenantId, campaignId, deliveryId, next]);
    await client.query(`UPDATE message_campaigns SET status='running',completed_at=NULL,updated_at=$3 WHERE tenant_id=$1 AND campaign_id=$2`, [tenantId, campaignId, next]);
    await client.query(`INSERT INTO message_campaign_delivery_events(delivery_id,campaign_id,tenant_id,event_type,facts) VALUES($1,$2,$3,'manual_retry',jsonb_build_object('reason',$4::text,'attempt_count',$5::int))`, [deliveryId, campaignId, tenantId, normalizedReason, delivery.rows[0].attempt_count]);
    await eventAndAudit(client, tenantId, campaignId, "delivery_retried", actor, { delivery_id: deliveryId, attempt_count: delivery.rows[0].attempt_count }, normalizedReason);
    await client.query("COMMIT"); return updated.rows[0];
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function scheduleMessageCampaign(tenantId: string, campaignId: string, input: Record<string, unknown>, reason: string, actor: CampaignActor, now = new Date()) {
  if (process.env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED !== "true") throw new CampaignError("campaign_execution_disabled", 409);
  const provider=process.env.MESSAGE_CAMPAIGN_PROVIDER ?? 'synthetic';
  const massScheduling=provider==='wechat_mass'&&process.env.MASS_CAMPAIGN_SCHEDULING_ENABLED==='true';
  if (provider!=='synthetic'&&!massScheduling) throw new CampaignError("campaign_provider_not_ready", 409);
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 10 || normalizedReason.length > 500) throw new CampaignError("schedule_reason_required");
  let schedule;
  try { schedule = normalizeCampaignSchedule(input, now); } catch (error) { throw new CampaignError(error instanceof Error ? error.message : "invalid_schedule"); }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(`SELECT * FROM message_campaigns WHERE tenant_id=$1 AND campaign_id=$2 FOR UPDATE`, [tenantId, campaignId]);
    const campaign = found.rows[0];
    if (!campaign) throw new CampaignError("campaign_not_found", 404);
    if (campaign.status === "scheduled") { await client.query("COMMIT"); return campaign; }
    if (campaign.status !== "approved") throw new CampaignError("campaign_not_schedulable", 409);
    await requireCampaignAccess(client, tenantId, campaign);
    if (!((campaign.channel==='mock-wechat'&&provider==='synthetic')||(campaign.channel==='wechat_official_account'&&massScheduling))) throw new CampaignError("real_campaign_provider_not_ready", 409);
    const effectiveStart = nextCampaignAllowedAt(schedule.scheduled_at, schedule.timezone, schedule.quiet_hours_start, schedule.quiet_hours_end);
    const updated = await client.query(
      `UPDATE message_campaigns SET status='scheduled',scheduled_at=$3,timezone=$4,quiet_hours_start=$5,quiet_hours_end=$6,
              rate_limit_per_minute=$7,cancel_condition=$8,updated_at=NOW()
        WHERE tenant_id=$1 AND campaign_id=$2 RETURNING *`,
      [tenantId, campaignId, schedule.scheduled_at, schedule.timezone, schedule.quiet_hours_start, schedule.quiet_hours_end, schedule.rate_limit_per_minute, JSON.stringify(schedule.cancel_condition)]
    );
    if(campaign.channel==='wechat_official_account'){
      let staged;
      try{staged=await stageMassAudience(client,tenantId,campaignId,campaign.channel_connection_id,campaign.content,schedule.rate_limit_per_minute,effectiveStart,Number(campaign.eligible_total));}
      catch(error){throw new CampaignError(error instanceof Error&&error.message.startsWith('mass_')?error.message:'mass_staging_failed',409);}
      await eventAndAudit(client,tenantId,campaignId,'scheduled',actor,{provider:'wechat_mass',scheduled_at:schedule.scheduled_at,effective_start:effectiveStart,...staged},normalizedReason);
      await client.query('COMMIT');return updated.rows[0];
    }
    const deliveries = await client.query<{ delivery_id: string }>(
      `INSERT INTO message_campaign_deliveries(campaign_id,recipient_id,tenant_id,scheduled_for,next_attempt_at)
       SELECT r.campaign_id,r.recipient_id,r.tenant_id,$3,$3 FROM message_campaign_recipients r
        WHERE r.campaign_id=$1 AND r.tenant_id=$2 AND r.eligible=TRUE
       ON CONFLICT(campaign_id,recipient_id) DO NOTHING RETURNING delivery_id`, [campaignId, tenantId, effectiveStart]
    );
    for (const delivery of deliveries.rows) await client.query(
      `INSERT INTO message_campaign_delivery_events(delivery_id,campaign_id,tenant_id,event_type,facts)
       VALUES($1,$2,$3,'queued',jsonb_build_object('scheduled_for',$4::timestamptz))`, [delivery.delivery_id, campaignId, tenantId, effectiveStart]
    );
    await eventAndAudit(client, tenantId, campaignId, "scheduled", actor, { scheduled_at: schedule.scheduled_at, effective_start: effectiveStart, timezone: schedule.timezone, rate_limit_per_minute: schedule.rate_limit_per_minute, queued: deliveries.rowCount }, normalizedReason);
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function cancelMessageCampaign(tenantId: string, campaignId: string, reason: string, actor: CampaignActor) {
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 10 || normalizedReason.length > 500) throw new CampaignError("cancel_reason_required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(`SELECT * FROM message_campaigns WHERE tenant_id=$1 AND campaign_id=$2 FOR UPDATE`, [tenantId, campaignId]);
    const campaign = found.rows[0];
    if (!campaign) throw new CampaignError("campaign_not_found", 404);
    if (campaign.status === "cancelled") { await client.query("COMMIT"); return campaign; }
    if (!['approved','scheduled','running','paused','failed'].includes(campaign.status)) throw new CampaignError("campaign_not_cancellable", 409);
    const cancelled = await client.query<{ delivery_id: string }>(
      `UPDATE message_campaign_deliveries SET status='cancelled',completed_at=NOW(),locked_at=NULL,worker_id=NULL,updated_at=NOW()
        WHERE tenant_id=$1 AND campaign_id=$2 AND status IN ('queued','processing','retry_pending') RETURNING delivery_id`, [tenantId, campaignId]
    );
    for (const delivery of cancelled.rows) await client.query(
      `INSERT INTO message_campaign_delivery_events(delivery_id,campaign_id,tenant_id,event_type,facts) VALUES($1,$2,$3,'cancelled','{}')`,
      [delivery.delivery_id, campaignId, tenantId]
    );
    const updated = await client.query(`UPDATE message_campaigns SET status='cancelled',completed_at=NOW(),updated_at=NOW() WHERE tenant_id=$1 AND campaign_id=$2 RETURNING *`, [tenantId, campaignId]);
    await eventAndAudit(client, tenantId, campaignId, "cancelled", actor, { cancelled_deliveries: cancelled.rowCount }, normalizedReason);
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function createMessageCampaign(tenantId: string, input: Record<string, unknown>, idempotencyKey: string, actor: CampaignActor) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw new CampaignError("idempotency_key_required");
  const normalized = normalizeCampaignInput(input);
  const hash = requestHash(normalized);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const connectionId = await requireCampaignAccess(client, tenantId, normalized);
    const inserted = await client.query(
      `INSERT INTO message_campaigns(tenant_id,name,channel,content,audience_filter,idempotency_key,request_hash,created_by,channel_connection_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING *`,
      [tenantId, normalized.name, normalized.channel, normalized.content, JSON.stringify(normalized.audience_filter), idempotencyKey, hash, actor.actor_id,connectionId]
    );
    let campaign = inserted.rows[0];
    if (!campaign) {
      const existing = await client.query(`SELECT * FROM message_campaigns WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE`, [tenantId, idempotencyKey]);
      campaign = existing.rows[0];
      if (!campaign || campaign.request_hash !== hash) throw new CampaignError("idempotency_key_conflict", 409);
    } else {
      await eventAndAudit(client, tenantId, campaign.campaign_id, "draft_created", actor, { channel: normalized.channel, audience_filter: normalized.audience_filter });
    }
    await client.query("COMMIT");
    return campaign;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function recordMarketingConsent(tenantId: string, identityId: string, input: Record<string, unknown>, idempotencyKey: string, actor: CampaignActor) {
  const status = input.status === "granted" || input.status === "withdrawn" ? input.status : null;
  const source = ["customer_action", "agent_recorded", "imported_with_evidence"].includes(String(input.source)) ? String(input.source) : null;
  const evidence = typeof input.evidence_ref === "string" ? input.evidence_ref.trim() : "";
  if (!status || !source || !/^[A-Za-z0-9._:/-]{8,200}$/.test(evidence)) throw new CampaignError("invalid_consent_event");
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw new CampaignError("idempotency_key_required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`marketing-consent:${tenantId}:${identityId}`]);
    const identity = await client.query(`SELECT 1 FROM channel_identities WHERE tenant_id=$1 AND identity_id=$2`, [tenantId, identityId]);
    if (!identity.rows[0]) throw new CampaignError("identity_not_found", 404);
    const inserted = await client.query(
      `INSERT INTO marketing_consent_events(tenant_id,identity_id,status,source,evidence_ref,actor_type,actor_id,request_id,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING consent_event_id,status,source,evidence_ref,created_at`,
      [tenantId, identityId, status, source, evidence, actor.actor_type, actor.actor_id, actor.request_id, idempotencyKey]
    );
    let event = inserted.rows[0];
    if (!event) {
      const existing = await client.query(`SELECT identity_id,consent_event_id,status,source,evidence_ref,created_at FROM marketing_consent_events WHERE tenant_id=$1 AND idempotency_key=$2`, [tenantId, idempotencyKey]);
      event = existing.rows[0];
      if (!event || event.identity_id !== identityId || event.status !== status || event.source !== source || event.evidence_ref !== evidence) throw new CampaignError("idempotency_key_conflict", 409);
    } else {
      await client.query(
        `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
         VALUES($1,$2,$3,'marketing_consent.recorded','channel_identity',$4,jsonb_build_object('status',$5::text,'source',$6::text,'evidence_ref',$7::text),$8)`,
        [tenantId, actor.actor_type, actor.actor_id, identityId, status, source, evidence, actor.request_id]
      );
    }
    await client.query("COMMIT");
    return event;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function snapshotMessageCampaign(tenantId: string, campaignId: string, actor: CampaignActor) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`message-campaign:${tenantId}:${campaignId}`]);
    const found = await client.query(`SELECT * FROM message_campaigns WHERE tenant_id=$1 AND campaign_id=$2 FOR UPDATE`, [tenantId, campaignId]);
    const campaign = found.rows[0];
    if (!campaign) throw new CampaignError("campaign_not_found", 404);
    await requireCampaignAccess(client, tenantId, campaign);
    if (campaign.status !== "draft") {
      if (["snapshotted", "approved"].includes(campaign.status)) { await client.query("COMMIT"); return campaign; }
      throw new CampaignError("campaign_not_snapshotable", 409);
    }
    const identities = await client.query(
      `SELECT i.identity_id,i.customer_id,i.sync_status,c.attributes,consent.consent_event_id,consent.status AS consent_status
         FROM channel_identities i JOIN customers c ON c.customer_id=i.customer_id AND c.tenant_id=i.tenant_id
         LEFT JOIN LATERAL (
           SELECT consent_event_id,status FROM marketing_consent_events e
            WHERE e.tenant_id=i.tenant_id AND e.identity_id=i.identity_id AND e.purpose='marketing'
            ORDER BY e.created_at DESC,e.consent_event_id DESC LIMIT 1
         ) consent ON TRUE
        WHERE i.tenant_id=$1 AND i.channel=$2
          AND ($2='mock-wechat' OR i.channel_connection_id=$3::uuid)
        ORDER BY i.identity_id LIMIT 10001`, [tenantId, campaign.channel,campaign.channel_connection_id]
    );
    if (identities.rows.length > 10000) throw new CampaignError('campaign_audience_too_large', 409);
    const filter = campaign.audience_filter as CampaignAudienceFilter;
    const audience = identities.rows.filter(row => matchesCampaignAudience(row.attributes, filter));
    let eligible = 0;
    for (const row of audience) {
      const decision = campaignRecipientDecision(row.consent_status, row.sync_status);
      if (decision.eligible) eligible += 1;
      await client.query(
        `INSERT INTO message_campaign_recipients(campaign_id,tenant_id,identity_id,customer_id,consent_event_id,eligible,suppression_reason)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [campaignId, tenantId, row.identity_id, row.customer_id, row.consent_event_id ?? null, decision.eligible, decision.suppression_reason]
      );
    }
    const suppressed = audience.length - eligible;
    const updated = await client.query(
      `UPDATE message_campaigns SET status='snapshotted',snapshot_at=NOW(),audience_total=$3,eligible_total=$4,suppressed_total=$5,updated_at=NOW()
        WHERE tenant_id=$1 AND campaign_id=$2 RETURNING *`, [tenantId, campaignId, audience.length, eligible, suppressed]
    );
    await eventAndAudit(client, tenantId, campaignId, "audience_snapshotted", actor, { audience_total: audience.length, eligible_total: eligible, suppressed_total: suppressed });
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function approveMessageCampaign(tenantId: string, campaignId: string, reason: string, actor: CampaignActor) {
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 10 || normalizedReason.length > 500) throw new CampaignError("approval_reason_required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(`SELECT * FROM message_campaigns WHERE tenant_id=$1 AND campaign_id=$2 FOR UPDATE`, [tenantId, campaignId]);
    const campaign = found.rows[0];
    if (!campaign) throw new CampaignError("campaign_not_found", 404);
    await requireCampaignAccess(client, tenantId, campaign);
    if (campaign.status === "approved") { await client.query("COMMIT"); return campaign; }
    if (campaign.status !== "snapshotted") throw new CampaignError("campaign_not_approvable", 409);
    if (Number(campaign.eligible_total) < 1) throw new CampaignError("campaign_has_no_eligible_recipients", 409);
    const updated = await client.query(
      `UPDATE message_campaigns SET status='approved',approved_by=$3,approval_reason=$4,approved_at=NOW(),updated_at=NOW()
        WHERE tenant_id=$1 AND campaign_id=$2 RETURNING *`, [tenantId, campaignId, actor.actor_id, normalizedReason]
    );
    await eventAndAudit(client, tenantId, campaignId, "approved", actor, { eligible_total: campaign.eligible_total, execution_enabled: false }, normalizedReason);
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
