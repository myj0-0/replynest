/** Durable intentional delay. This table is NOT an evidence or send grant.
 * Waiting survives restart; a claimed dispatch NEVER becomes waiting again.
 * Original generation worker tokens/point receipts and frozen answers stay intact. */
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {currentStoredAutomaticPresentation,type AutomaticPresentationOptions} from './reception-automatic-presentation.js';
import {receptionReplyCharacters} from './reception-presentation.js';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import type {ReceptionDraft,ReceptionState} from './reception-executor.js';
type Db=Pick<Pool,'query'|'connect'>;
export const automaticReplyWaitSchema=`
 CREATE TABLE automatic_reply_waits(
  job_id UUID PRIMARY KEY REFERENCES automatic_reception_jobs(job_id),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),worker_token UUID NOT NULL,
  draft_hash TEXT NOT NULL CHECK(draft_hash ~ '^[a-f0-9]{64}$'),
  presentation_hash TEXT NOT NULL CHECK(presentation_hash ~ '^[a-f0-9]{64}$'),
  characters INTEGER NOT NULL CHECK(characters BETWEEN 1 AND 4000),
  due_at TIMESTAMPTZ NOT NULL,expires_at TIMESTAMPTZ NOT NULL,ready_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'waiting' CHECK(state IN('waiting','claimed','finished','expired')),
  dispatch_token UUID,claimed_at TIMESTAMPTZ,finished_at TIMESTAMPTZ,reason TEXT,
  CHECK((state='waiting' AND dispatch_token IS NULL AND claimed_at IS NULL AND finished_at IS NULL AND reason IS NULL)
   OR (state='claimed' AND dispatch_token IS NOT NULL AND claimed_at IS NOT NULL AND finished_at IS NULL AND reason IS NULL)
   OR (state IN('finished','expired') AND finished_at IS NOT NULL AND reason ~ '^[a-z_]{1,100}$')),
  CHECK((dispatch_token IS NULL)=(claimed_at IS NULL)),CHECK(expires_at>due_at AND expires_at>ready_at),
  FOREIGN KEY(job_id) REFERENCES automatic_reception_presentations(job_id)
 );
 CREATE INDEX automatic_reply_wait_due ON automatic_reply_waits(due_at,job_id) WHERE state='waiting';
 CREATE INDEX automatic_reply_wait_claimed ON automatic_reply_waits(claimed_at,job_id) WHERE state='claimed';
 CREATE INDEX automatic_reply_wait_active ON automatic_reply_waits(ready_at,job_id) WHERE state IN('waiting','claimed');
 CREATE INDEX automatic_reply_wait_tenant_page ON automatic_reply_waits(tenant_id,ready_at DESC,job_id);
 CREATE FUNCTION guard_automatic_reply_wait() RETURNS trigger AS $$
 DECLARE j automatic_reception_jobs%ROWTYPE; p automatic_reception_presentations%ROWTYPE; delay_ms BIGINT;
 BEGIN
  IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'reply wait history is immutable'; END IF;
  SELECT * INTO j FROM automatic_reception_jobs WHERE job_id=NEW.job_id;
  IF j.job_id IS NULL OR ROW(j.tenant_id,j.worker_token,j.draft_hash) IS DISTINCT FROM ROW(NEW.tenant_id,NEW.worker_token,NEW.draft_hash)
   THEN RAISE EXCEPTION 'invalid reply wait owner'; END IF;
  IF TG_OP='INSERT' THEN
   SELECT * INTO p FROM automatic_reception_presentations WHERE job_id=NEW.job_id;
   IF j.state<>'processing' OR j.locked_at<=clock_timestamp()-INTERVAL '2 minutes' OR j.draft IS NULL
    OR p.job_id IS NULL OR ROW(p.tenant_id,p.worker_token,p.presentation_hash) IS DISTINCT FROM ROW(NEW.tenant_id,NEW.worker_token,NEW.presentation_hash)
    OR NEW.state<>'waiting' OR NEW.dispatch_token IS NOT NULL THEN RAISE EXCEPTION 'invalid reply wait preparation'; END IF;
   delay_ms:=CASE WHEN p.timing_enabled THEN floor(1000*(p.minimum_seconds+(p.maximum_seconds-p.minimum_seconds)*NEW.characters::numeric/(NEW.characters+120))) ELSE 0 END;
   NEW.ready_at:=clock_timestamp();
   NEW.due_at:=date_trunc('milliseconds',j.created_at)+delay_ms*INTERVAL '1 millisecond';
   -- A bounded late allowance covers polling/restart, not replay of old answers.
   NEW.expires_at:=greatest(NEW.due_at,NEW.ready_at)+INTERVAL '30 seconds';
   RETURN NEW;
  END IF;
  IF ROW(NEW.job_id,NEW.tenant_id,NEW.worker_token,NEW.draft_hash,NEW.presentation_hash,NEW.characters,NEW.due_at,NEW.expires_at,NEW.ready_at)
   IS DISTINCT FROM ROW(OLD.job_id,OLD.tenant_id,OLD.worker_token,OLD.draft_hash,OLD.presentation_hash,OLD.characters,OLD.due_at,OLD.expires_at,OLD.ready_at)
   THEN RAISE EXCEPTION 'reply wait snapshot is immutable'; END IF;
  IF OLD.state IN('finished','expired') OR NEW.state=OLD.state THEN RAISE EXCEPTION 'reply wait outcome is immutable'; END IF;
  IF OLD.dispatch_token IS NOT NULL AND ROW(NEW.dispatch_token,NEW.claimed_at) IS DISTINCT FROM ROW(OLD.dispatch_token,OLD.claimed_at)
   THEN RAISE EXCEPTION 'reply dispatch claim is immutable'; END IF;
  IF OLD.state='waiting' AND NEW.state='claimed' THEN
   IF j.state<>'processing' OR j.transport_attempted_at IS NOT NULL OR NEW.dispatch_token IS NULL
    OR clock_timestamp()<OLD.due_at OR clock_timestamp()>=OLD.expires_at
    THEN RAISE EXCEPTION 'reply dispatch is not due'; END IF;
   NEW.claimed_at:=clock_timestamp(); RETURN NEW;
  END IF;
  IF OLD.state='claimed' AND NEW.state='finished' AND j.state IN('draft','skipped','accepted','uncertain','failed') THEN
   NEW.finished_at:=clock_timestamp();RETURN NEW;
  END IF;
  IF NEW.state='expired' AND j.state IN('draft','skipped','accepted','uncertain','failed') AND
   (OLD.state='waiting' OR OLD.state='claimed' AND OLD.claimed_at<clock_timestamp()-INTERVAL '5 minutes') THEN
   NEW.finished_at:=clock_timestamp();RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid reply wait transition';
 END; $$ LANGUAGE plpgsql;
 CREATE TRIGGER automatic_reply_wait_guard BEFORE INSERT OR UPDATE OR DELETE ON automatic_reply_waits
  FOR EACH ROW EXECUTE FUNCTION guard_automatic_reply_wait();
 CREATE TRIGGER automatic_reply_wait_truncate_guard BEFORE TRUNCATE ON automatic_reply_waits
  FOR EACH STATEMENT EXECUTE FUNCTION guard_automatic_reply_wait();
 CREATE FUNCTION guard_automatic_reply_wait_submission() RETURNS trigger AS $$
 DECLARE w automatic_reply_waits%ROWTYPE;
 BEGIN
  SELECT * INTO w FROM automatic_reply_waits WHERE job_id=NEW.job_id FOR SHARE;
  IF w.job_id IS NOT NULL AND (w.state<>'claimed' OR w.dispatch_token IS NULL OR
   ROW(w.tenant_id,w.worker_token,w.draft_hash) IS DISTINCT FROM ROW(NEW.tenant_id,NEW.worker_token,NEW.draft_hash)
   OR clock_timestamp()<w.due_at OR clock_timestamp()>=w.expires_at)
   THEN RAISE EXCEPTION 'reply wait final barrier denied'; END IF;
  RETURN NEW;
 END; $$ LANGUAGE plpgsql;
 CREATE TRIGGER automatic_reply_wait_submission_guard BEFORE UPDATE OF state ON automatic_reception_jobs
  FOR EACH ROW WHEN(OLD.state='processing' AND NEW.state='submitting') EXECUTE FUNCTION guard_automatic_reply_wait_submission();
`;
export function automaticReplyWaitRuntimeAcl(runtime:string){
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(runtime))throw Error('invalid_reply_wait_runtime_role');
 return `REVOKE ALL ON TABLE automatic_reply_waits FROM PUBLIC,"${runtime}";
 GRANT SELECT,INSERT,UPDATE(state,dispatch_token,claimed_at,finished_at,reason) ON automatic_reply_waits TO "${runtime}";
 REVOKE ALL ON FUNCTION guard_automatic_reply_wait() FROM PUBLIC,"${runtime}";
 REVOKE ALL ON FUNCTION guard_automatic_reply_wait_submission() FROM PUBLIC,"${runtime}";
 GRANT EXECUTE ON FUNCTION guard_automatic_reply_wait(),guard_automatic_reply_wait_submission() TO "${runtime}";`;
}
async function tx<T>(db:Db,run:(c:PoolClient)=>Promise<T>){const c=await db.connect();try{
 await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s';SET LOCAL lock_timeout='500ms'");
 const result=await run(c);await c.query('COMMIT');return result;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
/** Original frozen draft must already be saved/qualified. q is the verified
 * adapter snapshot, not model output. Unknown persistence is fatal, never an
 * immediate-send fallback. No network/model/points or sleep in this function. */
export async function persistAutomaticReplyWait(db:Db,l:AutomaticReceptionLease,d:ReceptionDraft,q:string,o:AutomaticPresentationOptions){
 const characters=receptionReplyCharacters(d.text);if(characters<1||characters>4000)throw Error('invalid_reply_wait_text');
 return tx(db,async c=>{
  const job=(await c.query(`SELECT draft FROM automatic_reception_jobs WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3
   AND state='processing' FOR UPDATE`,[l.tenantId,l.jobId,l.workerToken])).rows[0];
  if(!job||JSON.stringify(Object.fromEntries(Object.keys(d).sort().map(k=>[k,d[k as keyof ReceptionDraft]])))!==
   JSON.stringify(Object.fromEntries(Object.keys(job.draft??{}).sort().map(k=>[k,job.draft[k]])))||
   !await currentStoredAutomaticPresentation(c,l,q,o))throw Error('reply_wait_presentation_changed');
  const r=await c.query(`INSERT INTO automatic_reply_waits(job_id,tenant_id,worker_token,draft_hash,presentation_hash,characters,due_at,expires_at,ready_at)
   SELECT j.job_id,j.tenant_id,j.worker_token,j.draft_hash,p.presentation_hash,$4,clock_timestamp(),clock_timestamp()+INTERVAL '30 seconds',clock_timestamp()
   FROM automatic_reception_jobs j JOIN automatic_reception_presentations p USING(job_id) WHERE j.tenant_id=$1 AND j.job_id=$2 AND j.worker_token=$3
   ON CONFLICT DO NOTHING RETURNING job_id`,[l.tenantId,l.jobId,l.workerToken,characters]);
  if(r.rowCount!==1)throw Error('reply_wait_already_prepared');return true;
 });
}
export type ClaimedAutomaticReply=Readonly<{lease:AutomaticReceptionLease;draft:ReceptionDraft;dispatchToken:string}>;
/** Atomic one-time claim. Refresh the original processing lease, NOT its worker
 * token. A crash after this commit is manual-review territory; never reclaimed.
 * The caller MUST reread current native facts/history and final source guards. */
export async function claimDueAutomaticReply(db:Db,family:'web'|'wechat'):Promise<ClaimedAutomaticReply|null>{
 if(!['web','wechat'].includes(family))throw Error('invalid_reply_wait_family');
 return tx(db,async c=>{
  const row=(await c.query(`SELECT j.* FROM automatic_reception_jobs j JOIN automatic_reply_waits w USING(job_id)
   WHERE w.state='waiting' AND w.due_at<=clock_timestamp() AND w.expires_at>clock_timestamp() AND j.state='processing'
   AND w.tenant_id=j.tenant_id AND w.worker_token=j.worker_token AND w.draft_hash=j.draft_hash AND j.transport_attempted_at IS NULL
   AND ${family==='web'?"j.channel='web_chat'":"j.channel IN('wechat_official_account','shared_wechat')"}
   ORDER BY w.due_at,w.job_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`)).rows[0];
  if(!row)return null;
  const dispatchToken=randomUUID();
  const r=await c.query(`UPDATE automatic_reply_waits SET state='claimed',dispatch_token=$3,claimed_at=clock_timestamp()
   WHERE tenant_id=$1 AND job_id=$2 AND state='waiting' AND due_at<=clock_timestamp() AND expires_at>clock_timestamp() RETURNING job_id`,
   [row.tenant_id,row.job_id,dispatchToken]);if(r.rowCount!==1)return null;
  await c.query(`UPDATE automatic_reception_jobs SET locked_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE job_id=$1 AND worker_token=$2 AND state='processing'`,[row.job_id,row.worker_token]);
  const lease:AutomaticReceptionLease=Object.freeze({tenantId:row.tenant_id,jobId:row.job_id,messageId:row.message_id,
   accountId:row.account_id,conversationId:row.conversation_id,customerId:row.customer_id,channel:row.channel,connectionId:row.connection_id,
   authorizationId:row.authorization_id,consentVersion:row.consent_version,workerToken:row.worker_token});
  return Object.freeze({lease,draft:Object.freeze({...row.draft}),dispatchToken});
 });
}
export async function finishAutomaticReplyWait(db:Db,v:ClaimedAutomaticReply,state:ReceptionState){
 const r=await db.query(`UPDATE automatic_reply_waits w SET state='finished',finished_at=clock_timestamp(),reason=$4
  FROM automatic_reception_jobs j WHERE w.tenant_id=$1 AND w.job_id=$2 AND w.dispatch_token=$3 AND w.state='claimed'
   AND j.job_id=w.job_id AND j.worker_token=w.worker_token AND j.state=$4 RETURNING w.job_id`,
  [v.lease.tenantId,v.lease.jobId,v.dispatchToken,state]);
 if(r.rowCount!==1)throw Error('reply_wait_outcome_not_committed');
}
/** Bounded keyset/index-backed cleanup. Late waiting answers are dropped; stale
 * claimed answers are marked for review. No reset/requeue or model/send retry. */
export async function expireAutomaticReplyWaits(db:Db){return tx(db,async c=>{
 const stale=(await c.query(`SELECT j.job_id,j.state,w.state wait_state FROM automatic_reception_jobs j JOIN automatic_reply_waits w USING(job_id)
  WHERE w.state IN('waiting','claimed') AND (w.state='waiting' AND (w.expires_at<=clock_timestamp() OR j.state IN('draft','skipped','accepted','uncertain','failed'))
   OR w.state='claimed' AND w.claimed_at<clock_timestamp()-INTERVAL '5 minutes')
  ORDER BY w.ready_at,w.job_id LIMIT 100 FOR UPDATE OF j SKIP LOCKED`)).rows;
 for(const row of stale){
  if(['processing','submitting'].includes(row.state))await c.query(`UPDATE automatic_reception_jobs SET
   state=CASE WHEN state='submitting' THEN 'uncertain' WHEN $2='waiting' THEN 'skipped' ELSE 'failed' END,
   reason=CASE WHEN $2='waiting' THEN 'reply_wait_expired' ELSE 'worker_interrupted_review_required' END,updated_at=clock_timestamp()
   WHERE job_id=$1 AND state IN('processing','submitting')`,[row.job_id,row.wait_state]);
  await c.query(`UPDATE automatic_reply_waits SET state='expired',finished_at=clock_timestamp(),reason=$2
   WHERE job_id=$1 AND state IN('waiting','claimed')`,[row.job_id,row.wait_state==='waiting'?'reply_wait_expired':'worker_interrupted_review_required']);
 }return stale.length;
 });}
