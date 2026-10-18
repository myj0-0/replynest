import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
type Db=Pick<PoolClient,'query'>;
export const receptionSchema=`
 ALTER TABLE tenant_ai_settings ADD COLUMN IF NOT EXISTS automation_consent_version TEXT;
 CREATE TABLE IF NOT EXISTS reception_jobs(
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  account_id TEXT NOT NULL,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,customer_id UUID NOT NULL,
  channel TEXT NOT NULL,authorization_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN('queued','processing','draft','skipped','failed','uncertain')),
  worker_token UUID,available_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '5 seconds',
  locked_at TIMESTAMPTZ,draft JSONB,reason TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id,account_id,message_id)
 );
 CREATE INDEX IF NOT EXISTS reception_jobs_pending ON reception_jobs(available_at,job_id) WHERE state='queued';
 CREATE INDEX IF NOT EXISTS reception_jobs_conversation ON reception_jobs(tenant_id,conversation_id,created_at DESC);
 CREATE INDEX IF NOT EXISTS reception_jobs_processing ON reception_jobs(locked_at) WHERE state='processing';
 CREATE INDEX IF NOT EXISTS reception_jobs_tenant_page ON reception_jobs(tenant_id,created_at DESC,job_id DESC);
 CREATE TABLE IF NOT EXISTS reception_scan_cursors(
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id),page INTEGER NOT NULL DEFAULT 1,
  page_offset INTEGER NOT NULL DEFAULT 0,next_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),worker_token UUID
 );
 CREATE INDEX IF NOT EXISTS reception_scan_due ON reception_scan_cursors(next_at,tenant_id);
 CREATE TABLE IF NOT EXISTS reception_events(
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  account_id TEXT NOT NULL,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,inbox_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN('shared_wechat','web_chat')),authorization_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','processing','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  worker_token UUID,locked_at TIMESTAMPTZ,reason TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id,account_id,message_id)
 );
 CREATE INDEX IF NOT EXISTS reception_events_pending ON reception_events(available_at,event_id) WHERE state='pending';
 CREATE INDEX IF NOT EXISTS reception_events_locked ON reception_events(locked_at) WHERE state='processing';
`;
/** Store only identifiers, atomically with the source receipt; model execution is a separate queue. */
export async function recordReceptionEvent(db:Db,input:{tenantId:string;accountId:string;conversationId:string;messageId:string;inboxId:string;channel:'shared_wechat'|'web_chat'}){
  return db.query(`INSERT INTO reception_events(tenant_id,account_id,conversation_id,message_id,inbox_id,channel,authorization_at)
    SELECT t.tenant_id,$2,$3,$4,$5,$6,s.automation_updated_at FROM tenants t JOIN tenant_ai_settings s USING(tenant_id)
    WHERE t.tenant_id=$1 AND t.chatwoot_account_id::text=$2 AND t.status IN('active','test')
      AND s.ai_auto_reply_enabled AND NOT s.automatic_sending_enabled AND s.automation_consent_version='automatic-reply-v1'
      AND s.automation_updated_at IS NOT NULL
    ON CONFLICT(tenant_id,account_id,message_id) DO NOTHING`,[input.tenantId,input.accountId,input.conversationId,input.messageId,input.inboxId,input.channel]);
}
export type StoredReceptionJob={job_id:string;tenant_id:string;account_id:string;conversation_id:string;message_id:string;customer_id:string;channel:string;authorization_at:Date;worker_token:string};

/** Called in the same transaction that records a verified inbound receipt. No caller-supplied destination. */
export async function enqueueReception(db:Db,input:{tenantId:string;channel:string;externalUserId:string;connectionId:string|null;messageId:string}) {
  const result=await db.query(`INSERT INTO reception_jobs(tenant_id,account_id,conversation_id,message_id,customer_id,channel,authorization_at)
   SELECT t.tenant_id,t.chatwoot_account_id::text,i.chatwoot_conversation_id::text,$5,i.customer_id,i.channel,s.automation_updated_at
   FROM channel_identities i JOIN tenants t ON t.tenant_id=i.tenant_id JOIN tenant_ai_settings s ON s.tenant_id=t.tenant_id
   WHERE i.tenant_id=$1 AND i.channel=$2 AND i.external_user_id=$3 AND i.channel_connection_id IS NOT DISTINCT FROM $4::uuid
    AND t.status IN('active','test') AND t.chatwoot_account_id IS NOT NULL AND s.ai_auto_reply_enabled=TRUE
    AND s.automatic_sending_enabled=FALSE AND s.automation_consent_version='automatic-reply-v1' AND s.automation_updated_at IS NOT NULL
   ON CONFLICT(tenant_id,account_id,message_id) DO NOTHING RETURNING job_id`,[input.tenantId,input.channel,input.externalUserId,input.connectionId,input.messageId]);
  return result.rowCount??0;
}
export async function claimReception(db:Db):Promise<StoredReceptionJob|undefined> {
  // Never regenerate after a crash: a metered model request may already have consumed points.
  await db.query(`WITH stale AS (
    SELECT job_id FROM reception_jobs WHERE state='processing' AND locked_at<NOW()-INTERVAL '5 minutes'
    ORDER BY locked_at FOR UPDATE SKIP LOCKED LIMIT 100
   ) UPDATE reception_jobs j SET state='failed',reason='worker_interrupted_review_required',updated_at=NOW()
    FROM stale s WHERE j.job_id=s.job_id`);
  const result=await db.query(`WITH candidate AS (
    SELECT job_id FROM reception_jobs WHERE state='queued' AND available_at<=NOW() ORDER BY available_at,job_id FOR UPDATE SKIP LOCKED LIMIT 1
   ) UPDATE reception_jobs j SET state='processing',worker_token=$1,locked_at=NOW(),updated_at=NOW()
   FROM candidate c WHERE j.job_id=c.job_id RETURNING j.*`,[randomUUID()]);
  return result.rows[0];
}

/** Verified upstream account/conversation only. A tenant-local customer identity must already exist. */
export async function enqueueConversationReception(db:Db,input:{tenantId:string;accountId:string;conversationId:string;messageId:string;channel:'shared_wechat'|'web_chat'}) {
  const result=await db.query(`INSERT INTO reception_jobs(tenant_id,account_id,conversation_id,message_id,customer_id,channel,authorization_at)
   SELECT t.tenant_id,t.chatwoot_account_id::text,i.chatwoot_conversation_id::text,$4,i.customer_id,i.channel,s.automation_updated_at
   FROM channel_identities i JOIN tenants t USING(tenant_id) JOIN tenant_ai_settings s USING(tenant_id)
   WHERE i.tenant_id=$1 AND t.chatwoot_account_id::text=$2 AND i.chatwoot_conversation_id::text=$3 AND i.channel=$5
    AND t.status IN('active','test') AND s.ai_auto_reply_enabled AND NOT s.automatic_sending_enabled
    AND s.automation_consent_version='automatic-reply-v1' AND s.automation_updated_at IS NOT NULL
   ON CONFLICT(tenant_id,account_id,message_id) DO NOTHING RETURNING job_id`,[input.tenantId,input.accountId,input.conversationId,input.messageId,input.channel]);
  return result.rowCount??0;
}
export async function finishReception(db:Db,j:StoredReceptionJob,state:'draft'|'skipped'|'failed',reason:string,draft:unknown=null) {
  const result=await db.query(`UPDATE reception_jobs SET state=$4,reason=$5,draft=$6,updated_at=NOW()
    WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3 AND state='processing' RETURNING job_id`,
    [j.tenant_id,j.job_id,j.worker_token,state,reason,draft]);
  if(!result.rowCount)throw new Error('reception_lease_lost');
}
