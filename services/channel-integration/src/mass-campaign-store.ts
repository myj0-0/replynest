import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {massTextPayload} from './wechat-mass-core.js';
import type {MassBatch,MassJob} from './mass-campaign-executor.js';
type Db=Pick<PoolClient,'query'>;
// A 10,000-recipient activity at 2/min can legitimately need 5,000 batches after quiet hours.
export const MAX_MASS_DEFERRALS=10_000;

/** Separate from synthetic per-recipient retries. Never reclaim submitting requests. */
export const massCampaignSchema=`
 CREATE TABLE IF NOT EXISTS message_campaign_mass_batches(
  batch_id UUID PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  campaign_id UUID NOT NULL REFERENCES message_campaigns(campaign_id),
  connection_id UUID NOT NULL REFERENCES channel_connections(connection_id),app_id TEXT NOT NULL,
  snapshot JSONB NOT NULL,snapshot_hash TEXT NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
  client_id TEXT NOT NULL UNIQUE CHECK(client_id ~ '^[a-f0-9]{32}$'),
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN('queued','preparing','submitting','submitted','uncertain','blocked','failed','succeeded','deleted')),
  worker_token UUID,locked_at TIMESTAMPTZ,receipt_id TEXT CHECK(receipt_id ~ '^[1-9][0-9]{0,19}$'),
  reason TEXT,query_token UUID,query_attempts INTEGER NOT NULL DEFAULT 0,query_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id,receipt_id),
  CHECK(state NOT IN('submitted','succeeded','deleted') OR receipt_id IS NOT NULL)
 );
 ALTER TABLE message_campaign_mass_batches ADD COLUMN IF NOT EXISTS query_attempts INTEGER NOT NULL DEFAULT 0;
 ALTER TABLE message_campaign_mass_batches ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
 ALTER TABLE message_campaign_mass_batches ADD COLUMN IF NOT EXISTS defer_count INTEGER NOT NULL DEFAULT 0;
 ALTER TABLE message_campaign_mass_batches DROP CONSTRAINT IF EXISTS message_campaign_mass_batches_defer_count_check;
 ALTER TABLE message_campaign_mass_batches ADD CONSTRAINT message_campaign_mass_batches_defer_count_check CHECK(defer_count BETWEEN 0 AND ${MAX_MASS_DEFERRALS});
 CREATE TABLE IF NOT EXISTS message_campaign_mass_progress(
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),campaign_id UUID NOT NULL REFERENCES message_campaigns(campaign_id),
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(tenant_id,campaign_id)
 );
 CREATE INDEX IF NOT EXISTS campaign_mass_progress_due ON message_campaign_mass_progress(next_check_at,tenant_id,campaign_id);
 CREATE INDEX IF NOT EXISTS campaign_mass_due ON message_campaign_mass_batches(available_at,batch_id) WHERE state='queued';
 CREATE INDEX IF NOT EXISTS campaign_mass_tenant ON message_campaign_mass_batches(tenant_id,campaign_id,created_at DESC,batch_id DESC);
 CREATE INDEX IF NOT EXISTS campaign_mass_stale ON message_campaign_mass_batches(locked_at,batch_id) WHERE state IN('preparing','submitting');
 CREATE INDEX IF NOT EXISTS campaign_mass_receipts ON message_campaign_mass_batches(query_after,batch_id) WHERE state='submitted';
 CREATE INDEX IF NOT EXISTS campaign_mass_rate ON message_campaign_mass_batches(app_id,locked_at);
 CREATE INDEX IF NOT EXISTS campaign_mass_live_metrics ON message_campaign_mass_batches(tenant_id,campaign_id,state)
  WHERE state IN('queued','preparing','submitting','submitted','uncertain');
 CREATE INDEX IF NOT EXISTS campaign_mass_recent_metrics ON message_campaign_mass_batches(tenant_id,updated_at)
  WHERE state IN('succeeded','blocked','failed','deleted');
 CREATE OR REPLACE FUNCTION protect_campaign_mass_batch() RETURNS trigger AS $$
 BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'mass batch history is immutable'; END IF;
  IF ROW(NEW.batch_id,NEW.tenant_id,NEW.campaign_id,NEW.connection_id,NEW.app_id,NEW.snapshot,NEW.snapshot_hash,NEW.client_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.batch_id,OLD.tenant_id,OLD.campaign_id,OLD.connection_id,OLD.app_id,OLD.snapshot,OLD.snapshot_hash,OLD.client_id,OLD.created_at)
    THEN RAISE EXCEPTION 'mass batch snapshot is immutable'; END IF;
  IF OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id THEN RAISE EXCEPTION 'mass receipt is immutable'; END IF;
  IF OLD.state='preparing' AND NEW.state='queued' THEN
   IF OLD.receipt_id IS NOT NULL OR NEW.receipt_id IS NOT NULL OR NEW.worker_token IS NOT NULL OR NEW.locked_at IS NOT NULL
    OR NEW.reason NOT IN('campaign_quiet_hours','campaign_rate_limited') OR NEW.reason IS NULL
    OR NEW.defer_count<>OLD.defer_count+1 OR NEW.available_at<=NOW() OR NEW.available_at>NOW()+INTERVAL '25 hours'
    THEN RAISE EXCEPTION 'invalid mass deferral'; END IF;
  ELSIF NEW.defer_count<>OLD.defer_count THEN RAISE EXCEPTION 'invalid mass deferral count'; END IF;
  IF NOT ((OLD.state=NEW.state) OR
    (OLD.state='queued' AND NEW.state='preparing') OR
    (OLD.state='preparing' AND NEW.state IN('queued','submitting','blocked','failed','uncertain')) OR
    (OLD.state='submitting' AND NEW.state IN('submitted','uncertain')) OR
    (OLD.state='submitted' AND NEW.state IN('succeeded','failed','deleted','uncertain')))
    THEN RAISE EXCEPTION 'invalid mass batch transition'; END IF;
  RETURN NEW;
 END;
 $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS campaign_mass_batch_guard ON message_campaign_mass_batches;
 CREATE TRIGGER campaign_mass_batch_guard BEFORE UPDATE OR DELETE ON message_campaign_mass_batches FOR EACH ROW EXECUTE FUNCTION protect_campaign_mass_batch();
 CREATE TABLE IF NOT EXISTS message_campaign_mass_reviews(
  review_id UUID PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  campaign_id UUID NOT NULL REFERENCES message_campaigns(campaign_id),batch_id UUID NOT NULL REFERENCES message_campaign_mass_batches(batch_id),
  actor_id TEXT NOT NULL,reason TEXT NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),
  observed_state TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 CREATE INDEX IF NOT EXISTS campaign_mass_reviews_lookup ON message_campaign_mass_reviews(tenant_id,campaign_id,batch_id,created_at DESC);
 CREATE OR REPLACE FUNCTION protect_mass_review() RETURNS trigger AS $$
 BEGIN RAISE EXCEPTION 'mass review is append only'; END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS mass_review_guard ON message_campaign_mass_reviews;
 CREATE TRIGGER mass_review_guard BEFORE UPDATE OR DELETE ON message_campaign_mass_reviews FOR EACH ROW EXECUTE FUNCTION protect_mass_review();
`;

/** Review acknowledges investigation only; never rewrites provider outcome or requeues. Caller owns transaction. */
export async function recordMassReview(db:Db,job:MassJob,actorId:string,reason:string){
 const normalized=reason.trim();
 if(normalized.length<10||normalized.length>500)throw Error('mass_review_reason_required');
 const batch=await db.query('SELECT state FROM message_campaign_mass_batches WHERE tenant_id=$1 AND campaign_id=$2 AND batch_id=$3 FOR UPDATE',[job.tenantId,job.campaignId,job.batchId]);
 if(!batch.rows[0])throw Error('mass_batch_not_found');
 if(!['uncertain','blocked','failed'].includes(batch.rows[0].state))throw Error('mass_batch_not_reviewable');
 const result=await db.query(`INSERT INTO message_campaign_mass_reviews(review_id,tenant_id,campaign_id,batch_id,actor_id,reason,observed_state)
  VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING review_id,observed_state,created_at`,[randomUUID(),job.tenantId,job.campaignId,job.batchId,actorId,normalized,batch.rows[0].state]);
 return result.rows[0];
}

function snapshot(batch:MassBatch){
 const p=massTextPayload(batch.openIds,batch.content,batch.clientId);
 const value={openIds:p.touser,content:p.text.content,clientId:p.clientmsgid};
 return {value,hash:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
}
export type MassLease=MassJob & {workerToken:string;batch:MassBatch;connectionId:string;appId:string};

/** Internal persistence only. Caller must validate plan/consent/quiet time; this is not send authorization. */
export async function stageMassBatch(db:Db,job:MassJob,connectionId:string,batch:MassBatch){
 const s=snapshot(batch);
 const inserted=await db.query(`WITH eligible AS(SELECT c.tenant_id,c.campaign_id,ch.connection_id,ch.external_account_id
  FROM message_campaigns c JOIN channel_connections ch ON ch.connection_id=c.channel_connection_id AND ch.tenant_id=c.tenant_id
  JOIN tenants t ON t.tenant_id=c.tenant_id
  WHERE c.tenant_id=$1 AND c.campaign_id=$2 AND ch.connection_id=$4 AND c.channel='wechat_official_account'
    AND c.status IN('approved','scheduled','running') AND ch.channel_type='wechat_official_account' AND ch.status='ready'
    AND t.status IN('active','test') AND ch.external_account_id IS NOT NULL AND ch.external_account_id<>'' FOR SHARE OF c,ch,t)
  INSERT INTO message_campaign_mass_batches(batch_id,tenant_id,campaign_id,connection_id,app_id,snapshot,snapshot_hash,client_id)
  SELECT $3,tenant_id,campaign_id,connection_id,external_account_id,$5,$6,$7 FROM eligible
  ON CONFLICT(batch_id) DO NOTHING RETURNING batch_id`,[job.tenantId,job.campaignId,job.batchId,connectionId,s.value,s.hash,batch.clientId]);
 if(!inserted.rowCount){
  const existing=await db.query(`SELECT snapshot_hash,connection_id FROM message_campaign_mass_batches WHERE tenant_id=$1 AND campaign_id=$2 AND batch_id=$3`,[job.tenantId,job.campaignId,job.batchId]);
  if(existing.rows[0]?.snapshot_hash!==s.hash||existing.rows[0]?.connection_id!==connectionId)throw Error('mass_snapshot_conflict_or_ineligible');
 }
 await db.query(`INSERT INTO message_campaign_mass_progress(tenant_id,campaign_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[job.tenantId,job.campaignId]);
}

export async function claimMassBatch(db:Db,job:MassJob):Promise<MassLease|null>{
 const token=randomUUID();
 const r=await db.query(`UPDATE message_campaign_mass_batches SET state='preparing',worker_token=$4,locked_at=NOW(),updated_at=NOW()
  WHERE tenant_id=$1 AND campaign_id=$2 AND batch_id=$3 AND state='queued' AND available_at<=NOW() RETURNING snapshot,connection_id,app_id`,[job.tenantId,job.campaignId,job.batchId,token]);
 if(!r.rows[0])return null;
 const batch:MassBatch=r.rows[0].snapshot;
 Object.freeze(batch.openIds);Object.freeze(batch);
 return Object.freeze({...job,workerToken:token,batch,connectionId:r.rows[0].connection_id,appId:r.rows[0].app_id});
}

/** Confirmed denial before the durable barrier only. Never accepts submitting/submitted/uncertain. */
export async function deferMassBatch(db:Db,lease:MassLease,reason:string,retryAt:Date){
 if(!['campaign_quiet_hours','campaign_rate_limited'].includes(reason)||!Number.isFinite(retryAt.getTime()))return false;
 const result=await db.query(`UPDATE message_campaign_mass_batches SET state='queued',available_at=$6,reason=$5,
  defer_count=defer_count+1,worker_token=NULL,locked_at=NULL,updated_at=NOW()
  WHERE tenant_id=$1 AND campaign_id=$2 AND batch_id=$3 AND worker_token=$4 AND state='preparing' AND receipt_id IS NULL
   AND defer_count<${MAX_MASS_DEFERRALS} AND $6::timestamptz>NOW() AND $6::timestamptz<=NOW()+INTERVAL '25 hours' RETURNING batch_id`,
  [lease.tenantId,lease.campaignId,lease.batchId,lease.workerToken,reason,retryAt]);
 return !!result.rowCount;
}

/** Call inside the transaction that rechecks current authorization. No network call before commit. */
export async function commitMassSubmitting(db:Db,lease:MassLease,batch:MassBatch){
 const s=snapshot(batch);
 const r=await db.query(`UPDATE message_campaign_mass_batches b SET state='submitting',locked_at=NOW(),updated_at=NOW()
  FROM message_campaigns c JOIN channel_connections ch ON ch.connection_id=c.channel_connection_id AND ch.tenant_id=c.tenant_id
  JOIN tenants t ON t.tenant_id=c.tenant_id
  WHERE b.tenant_id=$1 AND b.campaign_id=$2 AND b.batch_id=$3 AND b.worker_token=$4 AND b.state='preparing'
   AND b.snapshot_hash=$5 AND c.campaign_id=b.campaign_id AND c.tenant_id=b.tenant_id AND c.status IN('scheduled','running')
   AND ch.connection_id=b.connection_id AND ch.external_account_id=b.app_id AND ch.status='ready' AND t.status IN('active','test')
  RETURNING b.batch_id`,[lease.tenantId,lease.campaignId,lease.batchId,lease.workerToken,s.hash]);
 return !!r.rowCount;
}

export async function finishMassBatch(db:Db,lease:MassLease,state:'blocked'|'failed'|'uncertain'|'submitted',receipt?:string){
 if(state==='submitted'&&(!receipt||! /^[1-9][0-9]{0,19}$/.test(receipt)))throw Error('invalid_mass_receipt');
 // A lost commit acknowledgement may mean the transaction committed or rolled back.
 // Both outcomes must stay non-retryable when the executor cannot distinguish them.
 const from=state==='uncertain'?['preparing','submitting']:[state==='blocked'||state==='failed'?'preparing':'submitting'];
 const r=await db.query(`UPDATE message_campaign_mass_batches SET state=$5,receipt_id=$6,reason=COALESCE($7,reason),query_after=NOW()+INTERVAL '30 seconds',updated_at=NOW()
  WHERE tenant_id=$1 AND campaign_id=$2 AND batch_id=$3 AND worker_token=$4 AND state=ANY($8::text[]) RETURNING batch_id`,
  [lease.tenantId,lease.campaignId,lease.batchId,lease.workerToken,state,receipt??null,state==='uncertain'?'send_outcome_uncertain':null,from]);
 if(!r.rowCount)throw Error('mass_lease_lost');
}

export async function recoverMassBatches(db:Db){
 // Bounded recovery; neither state is returned to queued, even after a process crash.
 return db.query(`WITH stale AS(SELECT batch_id FROM message_campaign_mass_batches
  WHERE state IN('preparing','submitting') AND locked_at<NOW()-INTERVAL '5 minutes'
  ORDER BY locked_at,batch_id FOR UPDATE SKIP LOCKED LIMIT 100)
  UPDATE message_campaign_mass_batches b SET state=CASE WHEN state='submitting' THEN 'uncertain' ELSE 'failed' END,
   reason='worker_interrupted_review_required',updated_at=NOW() FROM stale s WHERE b.batch_id=s.batch_id`);
}

export type MassReceiptLease={batchId:string;tenantId:string;appId:string;connectionId:string;receiptId:string;queryToken:string};
export async function claimMassReceipt(db:Db):Promise<MassReceiptLease|null>{
 await db.query(`WITH exhausted AS(SELECT batch_id FROM message_campaign_mass_batches
  WHERE state='submitted' AND query_attempts>=20 AND query_after<=NOW() ORDER BY query_after,batch_id FOR UPDATE SKIP LOCKED LIMIT 100)
  UPDATE message_campaign_mass_batches b SET state='uncertain',reason='receipt_review_required',updated_at=NOW() FROM exhausted e WHERE b.batch_id=e.batch_id`);
 const token=randomUUID();
 const r=await db.query(`WITH due AS(SELECT batch_id FROM message_campaign_mass_batches WHERE state='submitted' AND query_attempts<20 AND query_after<=NOW()
  ORDER BY query_after,batch_id FOR UPDATE SKIP LOCKED LIMIT 1)
  UPDATE message_campaign_mass_batches b SET query_token=$1,query_attempts=query_attempts+1,query_after=NOW()+INTERVAL '2 minutes'
  FROM due d WHERE b.batch_id=d.batch_id RETURNING b.*`,[token]);
 const b=r.rows[0];return b?{batchId:b.batch_id,tenantId:b.tenant_id,appId:b.app_id,connectionId:b.connection_id,receiptId:b.receipt_id,queryToken:token}:null;
}
export async function reconcileMassReceipt(db:Db,lease:MassReceiptLease,status:'sending'|'succeeded'|'failed'|'deleted'){
 if(!['sending','succeeded','failed','deleted'].includes(status))throw Error('invalid_mass_status');
 const r=await db.query(`UPDATE message_campaign_mass_batches SET state=$5,query_token=NULL,query_after=NOW()+INTERVAL '2 minutes',updated_at=NOW()
  WHERE tenant_id=$1 AND batch_id=$2 AND query_token=$3 AND receipt_id=$4 AND state='submitted' RETURNING batch_id`,
  [lease.tenantId,lease.batchId,lease.queryToken,lease.receiptId,status==='sending'?'submitted':status]);
 if(!r.rowCount)throw Error('mass_receipt_lease_lost');
}
