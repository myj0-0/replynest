import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { inboundRetryDelaySeconds, safeInboundFailure } from "./inbound-queue-core.js";
import {enqueueReception} from './reception-store.js';
import type {WeChatMedia} from './wechat-media-core.js';
import type {Pool} from 'pg';
import type {InsightReceiptHooks} from './customer-insights-sources.js';

export type NormalizedInbound = {
  event_id: string;
  message_id: string;
  user_id: string;
  user_name?: string;
  text: string;
  occurred_at?: string;
  media?: WeChatMedia;
};

export type InboundJob = {
  id: string;
  tenant_id: string;
  channel: string;
  channel_connection_id: string | null;
  external_event_id: string;
  external_message_id: string;
  payload: { normalized: NormalizedInbound; provider_payload: unknown };
  attempt_count: number;
  max_attempts: number;
  worker_id: string;
};

export async function enqueueInbound(
  tenantId: string,
  channel: string,
  message: NormalizedInbound,
  providerPayload: unknown,
  connectionId: string | null = null
): Promise<{ id: string; duplicate: boolean; status: string }> {
  const inserted = await pool.query<{ id: string; status: string }>(
    `INSERT INTO gateway_events
       (tenant_id,channel,channel_connection_id,external_event_id,external_message_id,status,payload,next_attempt_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,'queued',$6,NOW(),NOW())
     ON CONFLICT DO NOTHING
     RETURNING id,status`,
    [tenantId, channel, connectionId, message.event_id, message.message_id, { normalized: message, provider_payload: providerPayload }]
  );
  if (inserted.rows[0]) return { ...inserted.rows[0], duplicate: false };
  const existing = await pool.query<{ id: string; status: string }>(
    `SELECT id,status FROM gateway_events
      WHERE tenant_id=$1 AND channel=$2 AND channel_connection_id IS NOT DISTINCT FROM $3::uuid
        AND (external_event_id=$4 OR external_message_id=$5)
      ORDER BY id LIMIT 1`,
    [tenantId, channel, connectionId, message.event_id, message.message_id]
  );
  if (!existing.rows[0]) throw new Error("inbound_deduplication_conflict");
  return { ...existing.rows[0], duplicate: true };
}

export async function claimInboundBatch(limit = 10): Promise<InboundJob[]> {
  const workerId = randomUUID();
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const result = await pool.query<InboundJob>(
    `WITH candidates AS (
       SELECT id FROM gateway_events
        WHERE ((status IN ('queued','retry_pending') AND next_attempt_at<=NOW())
           OR (status='processing' AND locked_at<NOW()-INTERVAL '60 seconds'))
        ORDER BY next_attempt_at,id
        FOR UPDATE SKIP LOCKED LIMIT $1
     )
     UPDATE gateway_events e SET status='processing',worker_id=$2,locked_at=NOW(),last_attempt_at=NOW(),
       attempt_count=e.attempt_count+1,updated_at=NOW(),error=NULL,failure_code=NULL
      FROM candidates c WHERE e.id=c.id
     RETURNING e.id,e.tenant_id,e.channel,e.channel_connection_id,e.external_event_id,e.external_message_id,e.payload,
       e.attempt_count,e.max_attempts,e.worker_id`,
    [boundedLimit, workerId]
  );
  return result.rows;
}

export async function completeInbound(job: InboundJob, chatwootMessageId: number|string, outboxPayload: unknown,
 options:{db?:Pick<Pool,'connect'>;insights?:InsightReceiptHooks['independent']}={}): Promise<void> {
  const client = await (options.db??pool).connect();
  try {
    await client.query("BEGIN");
    const completed = await client.query(
      `UPDATE gateway_events SET status='processed',chatwoot_message_id=$1,processed_at=NOW(),
         locked_at=NULL,worker_id=NULL,updated_at=NOW()
       WHERE id=$2 AND status='processing' AND worker_id=$3 RETURNING id`,
      [chatwootMessageId, job.id, job.worker_id]
    );
    if (!completed.rowCount) throw new Error("inbound_job_lease_lost");
    if(!job.payload.normalized.media&&process.env.AI_RECEPTION_DRAFT_WORKER_ENABLED==='true')await enqueueReception(client,{
      tenantId:job.tenant_id,channel:job.channel,externalUserId:job.payload.normalized.user_id,
      connectionId:job.channel_connection_id,messageId:String(chatwootMessageId)});
    await client.query(
      `INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,payload)
       VALUES ('message',$1,'inbound.message.accepted',$2)`,
      [job.external_message_id, outboxPayload]
    );
    // Supplied only by the verified native WeChat path, never legacy delivery.
    if(job.channel==='wechat_official_account'&&!job.payload.normalized.media)await options.insights?.(client,job.id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failInbound(job: InboundJob, error: unknown): Promise<"retry_pending" | "dead"> {
  const failure = safeInboundFailure(error);
  const permanent = failure.code === "permanent_upstream_rejection" || failure.code === "invalid_inbound_job";
  const dead = permanent || job.attempt_count >= job.max_attempts;
  const base = Number(process.env.INBOUND_QUEUE_RETRY_BASE_SECONDS ?? 5);
  const delay = inboundRetryDelaySeconds(job.attempt_count, Number.isFinite(base) ? base : 5);
  await pool.query(
    `UPDATE gateway_events SET status=$1,error=$2,failure_code=$3,
       next_attempt_at=CASE WHEN $1='retry_pending' THEN NOW()+make_interval(secs=>$4) ELSE next_attempt_at END,
       dead_at=CASE WHEN $1='dead' THEN NOW() ELSE NULL END,locked_at=NULL,worker_id=NULL,updated_at=NOW()
     WHERE id=$5 AND status='processing' AND worker_id=$6`,
    [dead ? "dead" : "retry_pending", failure.detail, failure.code, delay, job.id, job.worker_id]
  );
  return dead ? "dead" : "retry_pending";
}
