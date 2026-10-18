import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {ReceptionDraft,ReceptionJob,ReceptionState} from './reception-executor.js';
import {AUTOMATIC_SEND_CONSENT_VERSION} from './automatic-reply-policy.js';
import {automaticModeGuard} from './automatic-reception-mode.js';

type Db=Pick<PoolClient,'query'>;
/** Installed only by the opt-in gateway migration. Draft history stays separate. */
export const automaticReceptionSchema=`
 CREATE TABLE IF NOT EXISTS automatic_reception_grants(
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id),account_id TEXT NOT NULL CHECK(account_id ~ '^[1-9][0-9]{0,19}$'),
  authorization_id UUID NOT NULL UNIQUE,consent_version TEXT NOT NULL,enabled BOOLEAN NOT NULL DEFAULT false,
  actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 200),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 CREATE TABLE IF NOT EXISTS automatic_reception_jobs(
  job_id UUID PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),account_id TEXT NOT NULL CHECK(account_id ~ '^[1-9][0-9]{0,19}$'),
  conversation_id TEXT NOT NULL CHECK(conversation_id ~ '^[1-9][0-9]{0,19}$'),message_id TEXT NOT NULL CHECK(message_id ~ '^[1-9][0-9]{0,19}$'),customer_id UUID NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN('web_chat','wechat_official_account','shared_wechat')),
  connection_id UUID,authorization_id UUID NOT NULL,consent_version TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN('queued','processing','draft','skipped','submitting','accepted','uncertain','failed')),
  worker_token UUID,locked_at TIMESTAMPTZ,draft JSONB,draft_hash TEXT CHECK(draft_hash ~ '^[a-f0-9]{64}$'),
  receipt JSONB,reason TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id,account_id,message_id),
  CHECK((draft IS NULL)=(draft_hash IS NULL)),
  CHECK(state NOT IN('submitting','accepted') OR draft IS NOT NULL),
  CHECK(state<>'accepted' OR receipt IS NOT NULL),
  CHECK(receipt IS NULL OR state='accepted'),
  CHECK(receipt IS NULL OR (jsonb_typeof(receipt)='object' AND receipt->>'provider'=channel AND receipt->'acknowledged'='true'::jsonb) IS TRUE)
 );
 CREATE INDEX IF NOT EXISTS automatic_reception_pending ON automatic_reception_jobs(created_at,job_id) WHERE state='queued';
 CREATE INDEX IF NOT EXISTS automatic_reception_admission ON automatic_reception_jobs(tenant_id,job_id) WHERE state IN('queued','processing','submitting');
 CREATE INDEX IF NOT EXISTS automatic_reception_web_pending ON automatic_reception_jobs(created_at,job_id) WHERE state='queued' AND channel='web_chat';
 ALTER TABLE automatic_reception_jobs ADD COLUMN IF NOT EXISTS transport_attempted_at TIMESTAMPTZ;
 CREATE INDEX IF NOT EXISTS automatic_reception_stale ON automatic_reception_jobs(locked_at,job_id) WHERE state IN('processing','submitting');
 CREATE INDEX IF NOT EXISTS automatic_reception_tenant_page ON automatic_reception_jobs(tenant_id,created_at DESC,job_id DESC);
 CREATE OR REPLACE FUNCTION protect_automatic_reception_job() RETURNS trigger AS $$
 BEGIN
  IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'automatic reception history is immutable'; END IF;
  IF OLD.state IN('draft','skipped','accepted','uncertain','failed') AND NEW IS DISTINCT FROM OLD
   THEN RAISE EXCEPTION 'automatic reception terminal outcome is immutable'; END IF;
  IF ROW(NEW.job_id,NEW.tenant_id,NEW.account_id,NEW.conversation_id,NEW.message_id,NEW.customer_id,NEW.channel,NEW.connection_id,NEW.authorization_id,NEW.consent_version,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.job_id,OLD.tenant_id,OLD.account_id,OLD.conversation_id,OLD.message_id,OLD.customer_id,OLD.channel,OLD.connection_id,OLD.authorization_id,OLD.consent_version,OLD.created_at)
   THEN RAISE EXCEPTION 'automatic reception destination is immutable'; END IF;
  IF OLD.draft IS NOT NULL AND ROW(NEW.draft,NEW.draft_hash) IS DISTINCT FROM ROW(OLD.draft,OLD.draft_hash)
   THEN RAISE EXCEPTION 'automatic reception draft is immutable'; END IF;
  IF OLD.draft IS NULL AND NEW.draft IS NOT NULL AND NOT(OLD.state='processing' AND NEW.state='processing')
   THEN RAISE EXCEPTION 'invalid automatic draft preparation'; END IF;
  IF OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt THEN RAISE EXCEPTION 'automatic receipt is immutable'; END IF;
  IF OLD.transport_attempted_at IS NOT NULL AND NEW.transport_attempted_at IS DISTINCT FROM OLD.transport_attempted_at
   THEN RAISE EXCEPTION 'automatic transport attempt is immutable'; END IF;
  IF OLD.transport_attempted_at IS NULL AND NEW.transport_attempted_at IS NOT NULL AND NOT(OLD.state='submitting' AND NEW.state='submitting')
   THEN RAISE EXCEPTION 'automatic transport attempt requires submit barrier'; END IF;
  IF NEW.worker_token IS DISTINCT FROM OLD.worker_token AND NOT(OLD.state='queued' AND NEW.state='processing' AND NEW.worker_token IS NOT NULL)
   THEN RAISE EXCEPTION 'automatic reception lease is immutable'; END IF;
  IF NOT(OLD.state=NEW.state OR (OLD.state='queued' AND NEW.state IN('processing','skipped')) OR
   (OLD.state='processing' AND NEW.state IN('draft','skipped','failed','uncertain','submitting')) OR
   (OLD.state='submitting' AND NEW.state IN('accepted','failed','uncertain')))
   THEN RAISE EXCEPTION 'invalid automatic reception transition'; END IF;
  RETURN NEW;
 END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS automatic_reception_job_guard ON automatic_reception_jobs;
 CREATE TRIGGER automatic_reception_job_guard BEFORE UPDATE OR DELETE ON automatic_reception_jobs FOR EACH ROW EXECUTE FUNCTION protect_automatic_reception_job();
 DROP TRIGGER IF EXISTS automatic_reception_truncate_guard ON automatic_reception_jobs;
 CREATE TRIGGER automatic_reception_truncate_guard BEFORE TRUNCATE ON automatic_reception_jobs FOR EACH STATEMENT EXECUTE FUNCTION protect_automatic_reception_job();
`;

export type AutomaticReceptionInput=ReceptionJob & {
 accountId:string;conversationId:string;customerId:string;
 channel:'web_chat'|'wechat_official_account'|'shared_wechat';connectionId:string|null;
};
export type AutomaticReceptionLease=Readonly<AutomaticReceptionInput & {authorizationId:string;consentVersion:string;workerToken:string}>;
export type AutomaticReceipt=Readonly<{provider:'web_chat'|'wechat_official_account'|'shared_wechat';acknowledged:true;providerMessageId?:string}>;

function snapshot(d:ReceptionDraft){
 if(!d||typeof d.text!=='string'||!d.text.trim()||d.text.length>4000||
  ['generated','fallback','requiresHumanApproval','evidenceCandidate'].some(k=>typeof d[k as keyof ReceptionDraft]!=='boolean')||
  !Number.isFinite(d.confidencePercent)||d.confidencePercent<0||d.confidencePercent>100)throw Error('invalid_automatic_draft');
 const value={text:d.text,generated:d.generated,fallback:d.fallback,requiresHumanApproval:d.requiresHumanApproval,
  evidenceCandidate:d.evidenceCandidate,confidencePercent:d.confidencePercent};
 return {value,hash:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
}
const identityMatch=`i.tenant_id=j.tenant_id AND i.customer_id=j.customer_id AND i.channel=j.channel
 AND i.chatwoot_conversation_id::text=j.conversation_id AND i.channel_connection_id IS NOT DISTINCT FROM j.connection_id`;

/** Internal identifiers from a verified inbound receipt only; never model-chosen destinations.
 * This checks local bindings, not the upstream message. The ingress must verify that separately.
 */
export async function stageAutomaticReception(db:Db,input:AutomaticReceptionInput):Promise<ReceptionJob>{
 const r=await db.query(`INSERT INTO automatic_reception_jobs(job_id,tenant_id,account_id,conversation_id,message_id,customer_id,channel,connection_id,authorization_id,consent_version)
 SELECT $2,t.tenant_id,$3,$4,$5,$6,$7,$8,g.authorization_id,g.consent_version
 FROM tenants t JOIN automatic_reception_grants g USING(tenant_id) JOIN tenant_ai_settings s USING(tenant_id)
 WHERE t.tenant_id=$1 AND t.status IN('active','test') AND t.chatwoot_account_id::text=$3
 AND g.enabled AND g.account_id=$3 AND g.consent_version=$9
 AND ${automaticModeGuard}
 AND EXISTS(SELECT 1 FROM channel_identities i WHERE i.tenant_id=t.tenant_id AND i.customer_id=$6
  AND i.channel=$7 AND i.chatwoot_conversation_id::text=$4 AND i.channel_connection_id IS NOT DISTINCT FROM $8::uuid)
 AND ($7='shared_wechat' AND $8::uuid IS NULL OR EXISTS(SELECT 1 FROM channel_connections c
  WHERE c.tenant_id=t.tenant_id AND c.connection_id=$8 AND c.channel_type=$7 AND c.status='ready'))
 ON CONFLICT(tenant_id,account_id,message_id) DO NOTHING RETURNING job_id`,
 [input.tenantId,input.jobId,input.accountId,input.conversationId,input.messageId,input.customerId,input.channel,input.connectionId,AUTOMATIC_SEND_CONSENT_VERSION]);
 if(r.rowCount)return Object.freeze({tenantId:input.tenantId,jobId:r.rows[0].job_id,messageId:input.messageId});
 const prior=await db.query(`SELECT job_id FROM automatic_reception_jobs WHERE tenant_id=$1 AND account_id=$2 AND message_id=$3
 AND conversation_id=$4 AND customer_id=$5 AND channel=$6 AND connection_id IS NOT DISTINCT FROM $7::uuid`,
 [input.tenantId,input.accountId,input.messageId,input.conversationId,input.customerId,input.channel,input.connectionId]);
 if(!prior.rowCount)throw Error('automatic_reception_ineligible_or_conflict');
 // Existing events never regenerate, even after a new authorization is granted.
 return Object.freeze({tenantId:input.tenantId,jobId:prior.rows[0].job_id,messageId:input.messageId});
}

export async function claimAutomaticReception(db:Db,j:ReceptionJob):Promise<AutomaticReceptionLease|null>{
 const r=await db.query(`UPDATE automatic_reception_jobs SET state='processing',worker_token=$4,locked_at=NOW(),updated_at=NOW()
 WHERE tenant_id=$1 AND job_id=$2 AND message_id=$3 AND state='queued'
 AND created_at>NOW()-INTERVAL '10 minutes' RETURNING *`,[j.tenantId,j.jobId,j.messageId,randomUUID()]);
 const row=r.rows[0];if(!row)return null;
 return Object.freeze({...j,accountId:row.account_id,conversationId:row.conversation_id,customerId:row.customer_id,
  channel:row.channel,connectionId:row.connection_id,authorizationId:row.authorization_id,consentVersion:row.consent_version,workerToken:row.worker_token});
}
export async function automaticGrantCurrent(db:Db,l:AutomaticReceptionLease):Promise<boolean>{
 const r=await db.query(`SELECT 1 FROM automatic_reception_grants g JOIN tenants t USING(tenant_id) JOIN tenant_ai_settings s USING(tenant_id)
 WHERE g.tenant_id=$1 AND g.account_id=$2 AND g.authorization_id=$3 AND g.enabled AND g.consent_version=$4
 AND t.chatwoot_account_id::text=$2 AND t.status IN('active','test') AND ${automaticModeGuard}`,[l.tenantId,l.accountId,l.authorizationId,AUTOMATIC_SEND_CONSENT_VERSION]);
 return !!r.rowCount;
}
export async function saveAutomaticDraft(db:Db,l:AutomaticReceptionLease,d:ReceptionDraft){
 const s=snapshot(d);
 const r=await db.query(`UPDATE automatic_reception_jobs SET draft=$5,draft_hash=$6,updated_at=NOW()
 WHERE tenant_id=$1 AND job_id=$2 AND message_id=$3 AND worker_token=$4 AND state='processing' AND draft IS NULL RETURNING job_id`,
 [l.tenantId,l.jobId,l.messageId,l.workerToken,s.value,s.hash]);
 if(!r.rowCount)throw Error('automatic_reception_lease_lost');
}
/** Caller owns a transaction. Grant/binding rows are locked until COMMIT before HTTP.
 * Channel window, shared active merchant and latest-message/human checks belong to the adapter.
 */
export async function commitAutomaticSubmitting(db:Db,l:AutomaticReceptionLease,d:ReceptionDraft){
 const s=snapshot(d);
 const stored=await db.query(`SELECT * FROM automatic_reception_jobs WHERE tenant_id=$1 AND job_id=$2 AND message_id=$3 AND worker_token=$4 AND state='processing' FOR UPDATE`,[l.tenantId,l.jobId,l.messageId,l.workerToken]);
 const j=stored.rows[0];
 if(!j||j.account_id!==l.accountId||j.conversation_id!==l.conversationId||j.customer_id!==l.customerId||j.channel!==l.channel||
  j.connection_id!==l.connectionId||j.authorization_id!==l.authorizationId||j.consent_version!==l.consentVersion)return false;
 const grant=await db.query(`SELECT 1 FROM automatic_reception_grants g JOIN tenants t USING(tenant_id) JOIN tenant_ai_settings s USING(tenant_id)
 WHERE g.tenant_id=$1 AND g.account_id=$2 AND g.authorization_id=$3 AND g.enabled AND g.consent_version=$4
 AND t.chatwoot_account_id::text=$2 AND t.status IN('active','test') AND ${automaticModeGuard} FOR SHARE OF g,t,s`,
 [l.tenantId,l.accountId,l.authorizationId,AUTOMATIC_SEND_CONSENT_VERSION]);
 if(!grant.rowCount)return false;
 const binding=await db.query(`SELECT 1 FROM channel_identities i JOIN automatic_reception_jobs j ON ${identityMatch}
 WHERE j.tenant_id=$1 AND j.job_id=$2 AND j.message_id=$3 AND j.worker_token=$4 FOR SHARE OF i`,[l.tenantId,l.jobId,l.messageId,l.workerToken]);
 if(!binding.rowCount)return false;
 if(l.channel!=='shared_wechat'){
  const c=await db.query(`SELECT 1 FROM channel_connections WHERE tenant_id=$1 AND connection_id=$2 AND channel_type=$3 AND status='ready' FOR SHARE`,[l.tenantId,l.connectionId,l.channel]);
  if(!c.rowCount)return false;
 }
 const r=await db.query(`UPDATE automatic_reception_jobs SET state='submitting',locked_at=NOW(),updated_at=NOW()
 WHERE tenant_id=$1 AND job_id=$2 AND message_id=$3 AND worker_token=$4 AND state='processing' AND draft_hash=$5 RETURNING job_id`,
 [l.tenantId,l.jobId,l.messageId,l.workerToken,s.hash]);
 return !!r.rowCount;
}
export async function finishAutomaticReception(db:Db,l:AutomaticReceptionLease,state:ReceptionState,reason:string,receipt?:AutomaticReceipt){
 if(!['skipped','draft','accepted','uncertain','failed'].includes(state)||! /^[a-z_]{1,100}$/.test(reason))throw Error('invalid_automatic_result');
 if(state==='accepted'&&(!receipt||receipt.acknowledged!==true||receipt.provider!==l.channel||
  (receipt.providerMessageId!==undefined&&(typeof receipt.providerMessageId!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(receipt.providerMessageId)))))throw Error('invalid_automatic_receipt');
 const normalized=state==='accepted'?{provider:receipt!.provider,acknowledged:true,...(receipt!.providerMessageId?{providerMessageId:receipt!.providerMessageId}:{})}:null;
 const from=state==='accepted'?['submitting']:state==='uncertain'||state==='failed'?['processing','submitting']:['processing'];
 const r=await db.query(`UPDATE automatic_reception_jobs SET state=$5,reason=$6,receipt=$7,updated_at=NOW()
 WHERE tenant_id=$1 AND job_id=$2 AND message_id=$3 AND worker_token=$4 AND state=ANY($8::text[]) RETURNING job_id`,
 [l.tenantId,l.jobId,l.messageId,l.workerToken,state,reason,normalized,from]);
 if(!r.rowCount)throw Error('automatic_reception_lease_lost');
}
export async function recoverAutomaticReceptions(db:Db){
 // Never queue either phase again: a model debit or a public send may already exist.
 return db.query(`WITH stale AS(SELECT job_id FROM automatic_reception_jobs
 WHERE state IN('processing','submitting') AND locked_at<NOW()-INTERVAL '5 minutes'
 ORDER BY locked_at,job_id FOR UPDATE SKIP LOCKED LIMIT 100)
 UPDATE automatic_reception_jobs j SET state=CASE WHEN state='submitting' THEN 'uncertain' ELSE 'failed' END,
 reason='worker_interrupted_review_required',updated_at=NOW() FROM stale s WHERE j.job_id=s.job_id`);
}

/** Old queued work has never called the model. Expire it without acquiring a worker lease. */
export async function expireAutomaticReceptions(db:Db,limit=100){
 if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('invalid_automatic_batch');
 return db.query(`WITH stale AS(SELECT job_id FROM automatic_reception_jobs
 WHERE state='queued' AND created_at<=NOW()-INTERVAL '10 minutes'
 ORDER BY created_at,job_id FOR UPDATE SKIP LOCKED LIMIT $1)
 UPDATE automatic_reception_jobs j SET state='skipped',reason='queued_message_expired',updated_at=NOW()
 FROM stale s WHERE j.job_id=s.job_id`,[limit]);
}
