import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./database.js";
import { campaignDeliveryRetrySeconds, campaignRecipientDecision, isCampaignQuietTime, matchesCampaignCancelCondition, nextCampaignAllowedAt, type CampaignCancelCondition } from "./message-campaign-core.js";
import { emitNotification } from "./notification-gateway.js";

async function deliveryEvent(client: PoolClient, row: { delivery_id: string; campaign_id: string; tenant_id: string }, eventType: string, facts: unknown = {}) {
  await client.query(
    `INSERT INTO message_campaign_delivery_events(delivery_id,campaign_id,tenant_id,event_type,facts) VALUES($1,$2,$3,$4,$5)`,
    [row.delivery_id, row.campaign_id, row.tenant_id, eventType, JSON.stringify(facts)]
  );
}

async function campaignSystemEvent(client: PoolClient, campaignId: string, tenantId: string, eventType: "started"|"completed"|"failed", facts: unknown) {
  const requestId = randomUUID();
  await client.query(
    `INSERT INTO message_campaign_events(campaign_id,tenant_id,event_type,actor_type,actor_id,facts,request_id) VALUES($1,$2,$3,'system','message-campaign-worker',$4,$5)`,
    [campaignId, tenantId, eventType, JSON.stringify(facts), requestId]
  );
  await client.query(
    `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
     VALUES($1,'system','message-campaign-worker',$2,'message_campaign',$3,$4,$5)`,
    [tenantId, `message_campaign.${eventType}`, campaignId, JSON.stringify(facts), requestId]
  );
}

async function startDueCampaigns(now: Date) {
  const client = await pool.connect();
  let started = 0;
  try {
    await client.query("BEGIN");
    const due = await client.query<{ campaign_id: string; tenant_id: string }>(
      `SELECT campaign_id,tenant_id FROM message_campaigns WHERE channel='mock-wechat' AND status='scheduled' AND scheduled_at<=$1 ORDER BY scheduled_at FOR UPDATE SKIP LOCKED LIMIT 20`, [now]
    );
    for (const campaign of due.rows) {
      await client.query(`UPDATE message_campaigns SET status='running',started_at=$2,updated_at=$2 WHERE campaign_id=$1`, [campaign.campaign_id, now]);
      await campaignSystemEvent(client, campaign.campaign_id, campaign.tenant_id, "started", {});
      started += 1;
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  return started;
}

async function finalizeCampaign(client: PoolClient, campaignId: string, tenantId: string, now: Date) {
  const counts = await client.query<{ active: number; dead: number; delivered: number; suppressed: number }>(
    `SELECT COUNT(*) FILTER(WHERE status IN ('queued','retry_pending','processing'))::int active,
            COUNT(*) FILTER(WHERE status='dead')::int dead,COUNT(*) FILTER(WHERE status='delivered')::int delivered,
            COUNT(*) FILTER(WHERE status='suppressed')::int suppressed FROM message_campaign_deliveries WHERE campaign_id=$1`, [campaignId]
  );
  const values = counts.rows[0];
  if (values.active > 0) return;
  const status = values.dead > 0 ? "failed" : "completed";
  const updated = await client.query(`UPDATE message_campaigns SET status=$3,completed_at=$4,updated_at=$4 WHERE campaign_id=$1 AND tenant_id=$2 AND status='running' RETURNING campaign_id`, [campaignId, tenantId, status, now]);
  if (updated.rows[0]) await campaignSystemEvent(client, campaignId, tenantId, status, { delivered: values.delivered, suppressed: values.suppressed, dead: values.dead });
}

type Claimed = {
  delivery_id:string;campaign_id:string;tenant_id:string;recipient_id:string;identity_id:string;customer_id:string;attempt_count:number;
  channel:string;timezone:string;quiet_hours_start:string;quiet_hours_end:string;rate_limit_per_minute:number;cancel_condition:CampaignCancelCondition;
  sync_status:string;attributes:Record<string,unknown>;consent_status:string|null;
};

type ProcessOutcome = "delivered"|"suppressed"|"retry_pending"|"dead"|"deferred";
async function processOne(now: Date, workerId: string): Promise<{ outcome: ProcessOutcome; campaign_id: string; tenant_id: string } | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<Claimed>(
      `SELECT d.delivery_id,d.campaign_id,d.tenant_id,d.recipient_id,r.identity_id,r.customer_id,d.attempt_count,
              c.channel,c.timezone,c.quiet_hours_start::text,c.quiet_hours_end::text,c.rate_limit_per_minute,c.cancel_condition,
              i.sync_status,cu.attributes,consent.status AS consent_status
         FROM message_campaign_deliveries d JOIN message_campaigns c ON c.campaign_id=d.campaign_id
         JOIN message_campaign_recipients r ON r.recipient_id=d.recipient_id JOIN channel_identities i ON i.identity_id=r.identity_id AND i.tenant_id=d.tenant_id
         JOIN customers cu ON cu.customer_id=r.customer_id AND cu.tenant_id=d.tenant_id
         LEFT JOIN LATERAL (SELECT status FROM marketing_consent_events e WHERE e.tenant_id=d.tenant_id AND e.identity_id=r.identity_id AND e.purpose='marketing' ORDER BY e.created_at DESC,e.consent_event_id DESC LIMIT 1) consent ON TRUE
        WHERE c.channel='mock-wechat' AND c.status='running' AND d.status IN ('queued','retry_pending') AND d.next_attempt_at<=$1
          AND (SELECT COUNT(*) FROM message_campaign_delivery_events x
                 JOIN message_campaigns xc ON xc.campaign_id=x.campaign_id
                WHERE x.tenant_id=d.tenant_id AND xc.channel=c.channel AND x.event_type='attempted'
                  AND x.created_at>($1::timestamptz-INTERVAL '1 minute'))<c.rate_limit_per_minute
        ORDER BY d.next_attempt_at,d.delivery_id FOR UPDATE OF d SKIP LOCKED LIMIT 1`, [now]
    );
    const row = selected.rows[0];
    if (!row) { await client.query("COMMIT"); return null; }
    // Real-channel records belong to their dedicated executor. Never alter them
    // using synthetic delivery/retry semantics, even when providers are switched.
    if (row.channel !== 'mock-wechat') throw new Error('synthetic_campaign_boundary');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`marketing-consent:${row.tenant_id}:${row.identity_id}`]);
    if (isCampaignQuietTime(now, row.timezone, row.quiet_hours_start.slice(0,5), row.quiet_hours_end.slice(0,5))) {
      const next = nextCampaignAllowedAt(now, row.timezone, row.quiet_hours_start.slice(0,5), row.quiet_hours_end.slice(0,5));
      await client.query(`UPDATE message_campaign_deliveries SET next_attempt_at=$2,updated_at=$1 WHERE delivery_id=$3`, [now, next, row.delivery_id]);
      await client.query("COMMIT"); return { outcome: "deferred", campaign_id: row.campaign_id, tenant_id: row.tenant_id };
    }
    const latest = await client.query<{ status: string }>(`SELECT status FROM marketing_consent_events WHERE tenant_id=$1 AND identity_id=$2 AND purpose='marketing' ORDER BY created_at DESC,consent_event_id DESC LIMIT 1`, [row.tenant_id, row.identity_id]);
    const decision = campaignRecipientDecision(latest.rows[0]?.status, row.sync_status);
    const cancellationMatched = matchesCampaignCancelCondition(row.attributes, row.cancel_condition);
    if (!decision.eligible || cancellationMatched) {
      const reason = cancellationMatched ? "cancel_condition_matched" : decision.suppression_reason === "unsubscribed" ? "consent_withdrawn" : decision.suppression_reason;
      await client.query(`UPDATE message_campaign_deliveries SET status='suppressed',suppression_reason=$2,completed_at=$1,updated_at=$1 WHERE delivery_id=$3`, [now, reason, row.delivery_id]);
      await deliveryEvent(client, row, "suppressed", { reason });
      await finalizeCampaign(client, row.campaign_id, row.tenant_id, now);
      await client.query("COMMIT"); return { outcome: "suppressed", campaign_id: row.campaign_id, tenant_id: row.tenant_id };
    }
    const attempt = row.attempt_count + 1;
    await client.query(`UPDATE message_campaign_deliveries SET status='processing',attempt_count=$2,locked_at=$1,worker_id=$3,updated_at=$1 WHERE delivery_id=$4`, [now, attempt, workerId, row.delivery_id]);
    await deliveryEvent(client, row, "attempted", { attempt, provider: "synthetic" });
    const syntheticResult = String(row.attributes.synthetic_campaign_result ?? "delivered");
    if (syntheticResult === "retry_once" && attempt === 1) {
      const next = new Date(now.getTime() + campaignDeliveryRetrySeconds(attempt) * 1000);
      await client.query(`UPDATE message_campaign_deliveries SET status='retry_pending',failure_code='synthetic_retry_once',next_attempt_at=$2,locked_at=NULL,worker_id=NULL,updated_at=$1 WHERE delivery_id=$3`, [now, next, row.delivery_id]);
      await deliveryEvent(client, row, "retry_scheduled", { attempt, next_attempt_at: next });
      await client.query("COMMIT"); return { outcome: "retry_pending", campaign_id: row.campaign_id, tenant_id: row.tenant_id };
    }
    if (syntheticResult === "dead") {
      await client.query(`UPDATE message_campaign_deliveries SET status='dead',failure_code='synthetic_permanent_failure',completed_at=$1,locked_at=NULL,worker_id=NULL,updated_at=$1 WHERE delivery_id=$2`, [now, row.delivery_id]);
      await deliveryEvent(client, row, "dead", { attempt, failure_code: "synthetic_permanent_failure" });
      await finalizeCampaign(client, row.campaign_id, row.tenant_id, now);
      await client.query("COMMIT"); return { outcome: "dead", campaign_id: row.campaign_id, tenant_id: row.tenant_id };
    }
    const receipt = createHash("sha256").update(`${row.delivery_id}:${attempt}:synthetic`).digest("hex").slice(0,32);
    await client.query(`UPDATE message_campaign_deliveries SET status='delivered',provider_receipt_id=$2,delivered_at=$1,completed_at=$1,locked_at=NULL,worker_id=NULL,updated_at=$1 WHERE delivery_id=$3`, [now, receipt, row.delivery_id]);
    await deliveryEvent(client, row, "delivered", { attempt, provider: "synthetic" });
    await finalizeCampaign(client, row.campaign_id, row.tenant_id, now);
    await client.query("COMMIT"); return { outcome: "delivered", campaign_id: row.campaign_id, tenant_id: row.tenant_id };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function processMessageCampaignDeliveries(now = new Date(), batchSize = 20) {
  if (process.env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED !== "true" || (process.env.MESSAGE_CAMPAIGN_PROVIDER ?? "synthetic") !== "synthetic") return { started:0,claimed:0,delivered:0,suppressed:0,retry_pending:0,dead:0,deferred:0 };
  await pool.query(`UPDATE message_campaign_deliveries d SET status='retry_pending',next_attempt_at=$1,locked_at=NULL,worker_id=NULL,failure_code='stale_processing_recovered',updated_at=$1
    FROM message_campaigns c WHERE c.campaign_id=d.campaign_id AND c.tenant_id=d.tenant_id AND c.channel='mock-wechat'
    AND d.status='processing' AND d.locked_at<($1::timestamptz-INTERVAL '2 minutes')`, [now]);
  const result = { started: await startDueCampaigns(now), claimed:0, delivered:0, suppressed:0, retry_pending:0, dead:0, deferred:0 };
  const workerId = `campaign-${process.pid}-${randomUUID()}`;
  for (let index=0; index<Math.max(1,Math.min(batchSize,100)); index+=1) {
    const processed = await processOne(now, workerId);
    if (!processed) break;
    const outcome = processed.outcome;
    result.claimed += 1;
    result[outcome] += 1;
    const failed = await pool.query<{ campaign_id:string;tenant_id:string;name:string;dead_total:number }>(
        `SELECT c.campaign_id,c.tenant_id,c.name,COUNT(d.delivery_id) FILTER(WHERE d.status='dead')::int dead_total
           FROM message_campaigns c JOIN message_campaign_deliveries d ON d.campaign_id=c.campaign_id
          WHERE c.tenant_id=$1 AND c.campaign_id=$2 AND c.status='failed'
          GROUP BY c.campaign_id`, [processed.tenant_id, processed.campaign_id]
    );
    if (failed.rows[0]) {
      try {
        await emitNotification({ tenant_id: failed.rows[0].tenant_id, event_type: "campaign.delivery_failed", severity: "warning",
          title: "消息活动存在永久失败", summary: `活动“${failed.rows[0].name}”有 ${failed.rows[0].dead_total} 个收件人投递失败，请在消息与活动中检查。`,
          dedupe_key: `campaign-failed:${failed.rows[0].campaign_id}`, resource_type: "message_campaign", resource_id: failed.rows[0].campaign_id,
          actor_type: "system", actor_id: "message-campaign-worker", requires_action: true,
          delivery_mode: process.env.MESSAGE_CAMPAIGN_ALERT_EXTERNAL_ENABLED === "true" ? "configured" : "in_app_only" });
      } catch (error) { console.error("message_campaign_alert_failed", error instanceof Error ? error.message : "unknown"); }
    }
  }
  return result;
}
