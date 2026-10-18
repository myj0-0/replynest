import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import {openAutomaticWeChatEnvelope} from './automatic-wechat-history-envelope.js';
import {createAutomaticWeChatHistoryClient,type AutomaticWeChatHistoryRequest,type AutomaticWeChatHistoryResult} from './automatic-wechat-history-native-client.js';

/** Installed by the separate WeChat owner migration, never by worker startup.
 * Accepted outcome -> history queue is atomic. No full tenant/outcome scan per tick.
 * History retries can only call the native recording endpoint, NOT a send API.
 */
export const automaticWechatHistoryWorkerSchema=`
 CREATE TABLE IF NOT EXISTS automatic_reception_wechat_history(
  job_id UUID PRIMARY KEY REFERENCES automatic_reception_wechat_outcomes(job_id),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),send_worker_token UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','processing','recorded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 12),
  history_worker_token UUID,locked_until TIMESTAMPTZ,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  native_message_id TEXT CHECK(native_message_id ~ '^[1-9][0-9]{0,18}$'),
  reason TEXT CHECK(reason IN('history_recorded','history_rejected','history_unconfirmed','history_envelope_unavailable')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK((state='processing')=(locked_until IS NOT NULL)),
  CHECK(state<>'processing' OR (history_worker_token IS NOT NULL AND attempts>0)),
  CHECK((state='recorded')=(native_message_id IS NOT NULL)),
  CHECK((state IN('recorded','failed'))=(reason IS NOT NULL))
 );
 CREATE INDEX IF NOT EXISTS automatic_wechat_history_pending ON automatic_reception_wechat_history(next_attempt_at,job_id) WHERE state='pending';
 CREATE INDEX IF NOT EXISTS automatic_wechat_history_stale ON automatic_reception_wechat_history(locked_until,job_id) WHERE state='processing';
 CREATE OR REPLACE FUNCTION protect_automatic_wechat_history() RETURNS trigger AS $$
 BEGIN
  IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'automatic history is immutable'; END IF;
  IF ROW(NEW.job_id,NEW.tenant_id,NEW.send_worker_token,NEW.created_at) IS DISTINCT FROM
   ROW(OLD.job_id,OLD.tenant_id,OLD.send_worker_token,OLD.created_at) OR
   (OLD.state IN('recorded','failed') AND NEW IS DISTINCT FROM OLD)
   THEN RAISE EXCEPTION 'automatic history binding is immutable'; END IF;
  IF NOT(OLD.state=NEW.state OR OLD.state='pending' AND NEW.state='processing' OR
   OLD.state='processing' AND NEW.state IN('pending','recorded','failed'))
   THEN RAISE EXCEPTION 'invalid automatic history transition'; END IF;
  IF NEW.attempts IS DISTINCT FROM OLD.attempts AND NOT(OLD.state='pending' AND NEW.state='processing' AND NEW.attempts=OLD.attempts+1)
   THEN RAISE EXCEPTION 'invalid automatic history attempt'; END IF;
  IF NEW.history_worker_token IS DISTINCT FROM OLD.history_worker_token AND NOT(OLD.state='pending' AND NEW.state='processing')
   THEN RAISE EXCEPTION 'invalid automatic history worker'; END IF;
  RETURN NEW;
 END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS automatic_wechat_history_guard ON automatic_reception_wechat_history;
 CREATE TRIGGER automatic_wechat_history_guard BEFORE UPDATE OR DELETE ON automatic_reception_wechat_history
  FOR EACH ROW EXECUTE FUNCTION protect_automatic_wechat_history();
 DROP TRIGGER IF EXISTS automatic_wechat_history_no_truncate ON automatic_reception_wechat_history;
 CREATE TRIGGER automatic_wechat_history_no_truncate BEFORE TRUNCATE ON automatic_reception_wechat_history
  FOR EACH STATEMENT EXECUTE FUNCTION protect_automatic_wechat_history();
 CREATE OR REPLACE FUNCTION enqueue_automatic_wechat_history() RETURNS trigger AS $$
 BEGIN
  IF NEW.outcome='accepted' THEN
   INSERT INTO automatic_reception_wechat_history(job_id,tenant_id,send_worker_token)
    VALUES(NEW.job_id,NEW.tenant_id,NEW.worker_token) ON CONFLICT(job_id) DO NOTHING;
  END IF;
  RETURN NEW;
 END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS automatic_wechat_history_enqueue ON automatic_reception_wechat_outcomes;
 CREATE TRIGGER automatic_wechat_history_enqueue AFTER INSERT ON automatic_reception_wechat_outcomes
  FOR EACH ROW EXECUTE FUNCTION enqueue_automatic_wechat_history();
 INSERT INTO automatic_reception_wechat_history(job_id,tenant_id,send_worker_token)
  SELECT job_id,tenant_id,worker_token FROM automatic_reception_wechat_outcomes WHERE outcome='accepted' ON CONFLICT(job_id) DO NOTHING;
`;
type Db=Pick<Pool,'connect'>;
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
/** Fixed bounded lease, exponential backoff, 12 attempts maximum. An uncertain
 * native acknowledgement may be replayed with the SAME original command/body.
 * Revoking future sends does not erase previously acknowledged public history.
 */
export function createAutomaticWeChatHistoryWorker(db:Db,options:{
 origin:string;secret:string;enabled?:()=>boolean;fetcher?:typeof fetch;
 native?:{project:(request:AutomaticWeChatHistoryRequest)=>Promise<AutomaticWeChatHistoryResult>};
}){
 let stopped=false,active:Promise<number>|null=null,drain:Promise<void>|undefined;
 const enabled=()=>!stopped&&(options.enabled?.()??false);
 const native=options.native??createAutomaticWeChatHistoryClient({...options,enabled});
 async function tx<T>(work:(c:PoolClient)=>Promise<T>){
  const c=await db.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms'");
   const value=await work(c);await c.query('COMMIT');return value;
  }catch{await c.query('ROLLBACK').catch(()=>{});throw Error('automatic_wechat_history_store_unavailable');}finally{c.release();}
 }
 async function claim(){return tx(async c=>{
  await c.query(`WITH expired AS(SELECT job_id FROM automatic_reception_wechat_history
   WHERE state='processing' AND locked_until<clock_timestamp() ORDER BY locked_until,job_id LIMIT 20 FOR UPDATE SKIP LOCKED)
   UPDATE automatic_reception_wechat_history h SET state=CASE WHEN attempts>=12 THEN 'failed' ELSE 'pending' END,
    reason=CASE WHEN attempts>=12 THEN 'history_unconfirmed' ELSE NULL END,locked_until=NULL,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
   FROM expired WHERE h.job_id=expired.job_id`);
  if(!enabled())return null;
  const claimed=await c.query(`WITH candidate AS(SELECT job_id FROM automatic_reception_wechat_history
   WHERE state='pending' AND attempts<12 AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,job_id LIMIT 1 FOR UPDATE SKIP LOCKED)
   UPDATE automatic_reception_wechat_history h SET state='processing',attempts=attempts+1,history_worker_token=$1,
    locked_until=clock_timestamp()+INTERVAL '60 seconds',updated_at=clock_timestamp() FROM candidate
   WHERE h.job_id=candidate.job_id RETURNING h.*`,[randomUUID()]);
  if(!claimed.rows.length)return null;
  const h=claimed.rows[0];
  const data=await c.query(`SELECT j.*,e.envelope_version,e.nonce,e.auth_tag,e.ciphertext,o.content_sha256,
    to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') provider_accepted_at
   FROM automatic_reception_jobs j JOIN automatic_reception_wechat_outcomes o
    ON o.job_id=j.job_id AND o.tenant_id=j.tenant_id AND o.worker_token=j.worker_token
   LEFT JOIN automatic_reception_wechat_envelopes e ON e.job_id=j.job_id AND e.tenant_id=j.tenant_id AND e.worker_token=j.worker_token
   WHERE j.job_id=$1 AND j.tenant_id=$2 AND j.worker_token=$3 AND o.outcome='accepted' AND j.transport_attempted_at IS NOT NULL
    AND j.channel IN('wechat_official_account','shared_wechat')`,[h.job_id,h.tenant_id,h.send_worker_token]);
  return {h,row:data.rows[0]};
 });}
 async function finish(h:any,result:AutomaticWeChatHistoryResult|'envelope_unavailable'){
  await tx(async c=>{
   const recorded=typeof result==='object'&&result.outcome==='recorded'&&id(result.messageId);
   const retry=typeof result==='object'&&result.outcome==='uncertain'&&h.attempts<12;
   const state=recorded?'recorded':retry?'pending':'failed';
   const reason=recorded?'history_recorded':retry?null:result==='envelope_unavailable'?'history_envelope_unavailable':
    typeof result==='object'&&result.outcome==='rejected'?'history_rejected':'history_unconfirmed';
   await c.query(`UPDATE automatic_reception_wechat_history SET state=$4,reason=$5,native_message_id=$6,locked_until=NULL,
    next_attempt_at=clock_timestamp()+$7*INTERVAL '1 second',updated_at=clock_timestamp()
    WHERE job_id=$1 AND tenant_id=$2 AND history_worker_token=$3 AND state='processing' AND locked_until>clock_timestamp()
     AND send_worker_token=$8 AND attempts=$9`,[h.job_id,h.tenant_id,h.history_worker_token,state,reason,
      recorded?(result as {messageId:string}).messageId:null,Math.min(300,2**h.attempts),h.send_worker_token,h.attempts]);
  });
 }
 async function tick(){
  if(!enabled())return 0;
  const claimed=await claim();if(!claimed)return 0;
  const {h,row}=claimed;let request:AutomaticWeChatHistoryRequest;
  try{
   if(!row)throw Error();
   const l:AutomaticReceptionLease={jobId:row.job_id,tenantId:row.tenant_id,workerToken:row.worker_token,
    channel:row.channel,accountId:row.account_id,conversationId:row.conversation_id,messageId:row.message_id,
    customerId:row.customer_id,connectionId:row.connection_id,authorizationId:row.authorization_id,consentVersion:row.consent_version};
   const value=openAutomaticWeChatEnvelope(l,row,options.secret);
   if(sha(value.content)!==row.content_sha256)throw Error();
   request={target:value.target,messageId:l.messageId,commandId:l.jobId,content:value.content,providerAcceptedAt:row.provider_accepted_at};
  }catch{await finish(h,'envelope_unavailable');return 1;}
  // No transaction spans HTTP. Stop leaves a recoverable recording-only lease.
  if(!enabled())return 0;
  let result:AutomaticWeChatHistoryResult;
  try{result=await native.project(request);}catch{result={outcome:'uncertain'};}
  await finish(h,result);return 1;
 }
 return {
  tick:()=>{
   if(active||!enabled())return Promise.resolve(0);
   const run=tick();active=run;void run.finally(()=>{if(active===run)active=null;}).catch(()=>{});return run;
  },
  stop:()=>{if(!drain){stopped=true;drain=Promise.resolve(active).then(()=>{},()=>{throw Error('automatic_wechat_history_stop_failed');});}return drain;}
 };
}
