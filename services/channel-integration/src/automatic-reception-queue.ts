import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {Pool,PoolClient} from 'pg';
import {authenticateChatwootCallback} from './chatwoot-callback-security.js';
import {AUTOMATIC_SEND_CONSENT_VERSION} from './automatic-reply-policy.js';
import {automaticModeGuard} from './automatic-reception-mode.js';
import {stageAutomaticReception,expireAutomaticReceptions,recoverAutomaticReceptions} from './automatic-reception-store.js';
import {recoverAutomaticGenerations} from './automatic-reception-generation.js';
import {recoverAutomaticSemanticRetrievals} from './automatic-knowledge-semantic-store.js';
import {recoverAutomaticSemanticVerifications} from './automatic-knowledge-verification.js';
import {executeStoredAutomaticReception,type AutomaticReceptionAdapter} from './automatic-reception-runtime.js';
import type {AutomaticNativeSnapshot} from './automatic-web-native-client.js';
import type {AutomaticWebTarget} from './automatic-web-chat.js';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import type {ReceptionDraft} from './reception-executor.js';

type Db=Pick<Pool,'query'|'connect'>;
export type AutomaticInbound={account:string;inbox:string;conversation:string;message:string};
const id=(v:unknown):string|null=>{
 if(typeof v==='number'&&!Number.isSafeInteger(v))return null;
 const s=typeof v==='string'||typeof v==='number'?String(v):'';
 return /^[1-9]\d{0,18}$/.test(s)&&BigInt(s)<=9223372036854775807n?s:null;
};
export function automaticInbound(body:Buffer):AutomaticInbound|null{
 let p;try{p=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{throw Error('invalid_automatic_callback');}
 if(p?.event!=='message_created'||p.private!==false||![0,'incoming'].includes(p.message_type))return null;
 const account=id(p.account?.id),inbox=id(p.inbox?.id??p.conversation?.inbox_id),conversation=id(p.conversation?.id),message=id(p.id);
 if(!account||!inbox||!conversation||!message)throw Error('invalid_automatic_callback');
 return {account,inbox,conversation,message};
}
async function target(db:Pick<PoolClient,'query'>,e:AutomaticInbound,lock=false){
 const r=await db.query(`SELECT t.tenant_id,g.authorization_id,g.updated_at authorization_at,
 c.connection_id,i.customer_id,i.chatwoot_contact_id::text contact_id
 FROM channel_connections c JOIN tenants t USING(tenant_id) JOIN automatic_reception_grants g USING(tenant_id)
 JOIN tenant_ai_settings s USING(tenant_id)
 JOIN channel_identities i ON i.tenant_id=t.tenant_id AND i.channel_connection_id=c.connection_id
 WHERE c.channel_type='web_chat' AND c.status='ready' AND t.status IN('active','test')
 AND t.chatwoot_account_id::text=$1 AND c.configuration->>'chatwoot_account_id'=$1
 AND c.configuration->>'chatwoot_inbox_id'=$2 AND g.account_id=$1 AND g.enabled AND g.consent_version=$4
 AND ${automaticModeGuard}
 AND i.channel='web_chat' AND i.chatwoot_conversation_id::text=$3 AND i.customer_id IS NOT NULL
 ORDER BY i.identity_id LIMIT 2 ${lock?'FOR SHARE OF c,t,g,i,s':''}`,[e.account,e.inbox,e.conversation,AUTOMATIC_SEND_CONSENT_VERSION]);
 if(r.rows.length!==1||!id(r.rows[0].contact_id))return null;
 const row=r.rows[0];
 const value:AutomaticWebTarget=Object.freeze({tenantId:row.tenant_id,accountId:e.account,inboxId:e.inbox,conversationId:e.conversation,
  connectionId:row.connection_id,customerId:row.customer_id,contactId:row.contact_id,authorizationAt:new Date(row.authorization_at).toISOString()});
 return {value,authorizationId:row.authorization_id};
}
export const automaticQueueSchema=`
 CREATE INDEX IF NOT EXISTS automatic_web_inbox_lookup ON channel_connections
 ((configuration->>'chatwoot_account_id'),(configuration->>'chatwoot_inbox_id'),tenant_id,connection_id)
 WHERE channel_type='web_chat' AND status='ready';
`;
export type AutomaticIngressResult='disabled'|'ignored'|'unavailable'|'backpressure'|'queued'|'duplicate';
/** Server-only ingress; gateway composition must explicitly register/enable it.
 * Unknown/missing projections are retryable. Upstream snapshots, never callback content, verify source.
 * No model/points/send here. HMAC duplicates rely on immutable database message deduplication.
 */
export function createAutomaticWebIngress(db:Db,options:{secret:string;enabled?:()=>boolean;
 snapshot:(target:AutomaticWebTarget,message:string)=>Promise<AutomaticNativeSnapshot>;now?:()=>number;monotonicNow?:()=>number}){
 const enabled=options.enabled??(()=>false);
 // Native source timestamps, not callback delivery timestamps, determine
 // admission. Bind the running instance to DATABASE time minus monotonic
 // elapsed startup time; never trust provider/model payload dates or Date.now.
 // The native snapshot already rejects messages older than authorizationAt.
 const monotonicNow=options.monotonicNow??(()=>performance.now());
 let activated=enabled()?monotonicNow():null,revision=0,admissionAt:string|null=null;
 let pending:Promise<string|null>|null=null;
 function available(){
  if(!enabled()){if(activated!==null)revision++;activated=null;admissionAt=null;pending=null;return false;}
  if(activated===null){activated=monotonicNow();revision++;}
  return true;
 }
 function admission():Promise<string|null>{
  if(!available())return Promise.resolve(null);
  if(admissionAt!==null)return Promise.resolve(admissionAt);
  if(pending)return pending;
  const expectedRevision=revision,start=activated!;
  const work=(async()=>{
   const elapsed=Math.floor(monotonicNow()-start);
   if(!Number.isSafeInteger(elapsed)||elapsed<0)throw Error('invalid_web_admission_clock');
   const row=(await db.query(`SELECT CEIL(EXTRACT(EPOCH FROM clock_timestamp())*1000-$1::double precision)::text admission_ms`,[elapsed])).rows[0];
   const ms=Number(row?.admission_ms);
   if(!Number.isSafeInteger(ms)||ms<=0||ms>8640000000000000)throw Error('invalid_web_admission_clock');
   if(!available()||revision!==expectedRevision)return null;
   admissionAt=new Date(ms).toISOString();return admissionAt;
  })();
  pending=work;void work.finally(()=>{if(pending===work)pending=null;}).catch(()=>{});return work;
 }
 return async(body:Buffer,timestamp:unknown,signature:unknown):Promise<AutomaticIngressResult>=>{
  if(!available())return 'disabled';
  if(body.length>32768||!authenticateChatwootCallback(options.secret,timestamp,signature,body,options.now?.()))throw Error('automatic_callback_unauthorized');
  const e=automaticInbound(body);if(!e)return 'ignored';
  const expectedRevision=revision;
  let cutoff:string|null;
  try{cutoff=await admission();}catch{return 'unavailable';}
  if(!cutoff||!available()||revision!==expectedRevision)return 'ignored';
  let before:Awaited<ReturnType<typeof target>>;
  try{before=await target(db,e);}catch{return 'unavailable';}
  if(!before)return 'unavailable';
  let snapshot:AutomaticNativeSnapshot;
  try{snapshot=await options.snapshot(Object.freeze({...before.value,
   authorizationAt:new Date(Math.max(Date.parse(before.value.authorizationAt),Date.parse(cutoff))).toISOString()}),e.message);}catch{return 'unavailable';}
  if(!snapshot.current||snapshot.human||!snapshot.replyable)return 'ignored';
  const c=await db.connect();
  try{
   await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms'");
   // Serialize admission only, not model/HTTP. Fixed namespace shared by every gateway instance.
   await c.query('SELECT pg_advisory_xact_lock(714201,1)');
   const current=await target(c,e,true);
   if(!available()||revision!==expectedRevision||!current||JSON.stringify(current)!==JSON.stringify(before)){await c.query('ROLLBACK');return 'ignored';}
   const prior=await c.query(`SELECT 1 FROM automatic_reception_jobs WHERE tenant_id=$1 AND account_id=$2 AND message_id=$3
    AND conversation_id=$4 AND customer_id=$5 AND connection_id=$6 AND channel='web_chat'`,
    [current.value.tenantId,e.account,e.message,e.conversation,current.value.customerId,current.value.connectionId]);
   if(prior.rowCount){await c.query('COMMIT');return 'duplicate';}
   const cap=await c.query(`SELECT
    (SELECT count(*) FROM (SELECT 1 FROM automatic_reception_jobs WHERE tenant_id=$1 AND state IN('queued','processing','submitting') LIMIT 100) t) tenant_count,
    (SELECT count(*) FROM (SELECT 1 FROM automatic_reception_jobs WHERE state IN('queued','processing','submitting') LIMIT 1000) t) global_count`,[current.value.tenantId]);
   if(Number(cap.rows[0].tenant_count)>=100||Number(cap.rows[0].global_count)>=1000){await c.query('ROLLBACK');return 'backpressure';}
   if(!available()||revision!==expectedRevision){await c.query('ROLLBACK');return 'ignored';}
   await stageAutomaticReception(c,{tenantId:current.value.tenantId,jobId:randomUUID(),accountId:e.account,conversationId:e.conversation,
    messageId:e.message,customerId:current.value.customerId,channel:'web_chat',connectionId:current.value.connectionId});
   if(!available()||revision!==expectedRevision){await c.query('ROLLBACK');return 'ignored';}
   await c.query('COMMIT');return 'queued';
  }catch{await c.query('ROLLBACK').catch(()=>{});return 'unavailable';}finally{c.release();}
 };
}
/** One shared database worker slot, bounded FIFO batch and single-flight per process.
 * Session lock spans HTTP but NO database transaction/row lock spans the whole batch.
 * Pool must have >=2 connections; lock holder is discarded if unlocking fails.
 * Stop checks between jobs, drains in-flight work; never retry an uncertain model/send.
 */
export function createAutomaticReceptionQueue(db:Db,options:{enabled?:()=>boolean;adapter:AutomaticReceptionAdapter;channelFamily?:'web'|'wechat';semanticMaintenanceEnabled?:()=>boolean;
 defer?:(l:AutomaticReceptionLease,d:ReceptionDraft)=>Promise<boolean>}){
 if(options.channelFamily!==undefined&&!['web','wechat'].includes(options.channelFamily))throw Error('invalid_automatic_queue_family');
 const wechat=options.channelFamily==='wechat',slot=wechat?3:2;
 const enabled=options.enabled??(()=>false);let busy=false,stopped=false,active:Promise<number>|null=null;
 async function run(){
  if(stopped||busy||!enabled())return 0;
  busy=true;let c:PoolClient|undefined,held=false;
  try{
   c=await db.connect();
   held=(await c.query('SELECT pg_try_advisory_lock(714201,$1) locked',[slot])).rows[0].locked===true;
   if(!held||stopped||!enabled())return 0;
   await expireAutomaticReceptions(c);await recoverAutomaticReceptions(c);
   await recoverAutomaticGenerations(c,new Date(Date.now()-6*60_000),100);
   if((options.semanticMaintenanceEnabled??(()=>process.env.AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED==='true'))()){
    // Recover bounded stale journals only. Never resubmit models, refund guessed
    // usage, reset immutable outcomes or replay old customer questions.
    const before=new Date(Date.now()-6*60_000);
    await recoverAutomaticSemanticRetrievals(c,before,100);
    await recoverAutomaticSemanticVerifications(c,before,100);
   }
   const pending=await c.query(`SELECT tenant_id,job_id,message_id FROM automatic_reception_jobs
    WHERE state='queued' AND ${wechat?"channel IN('wechat_official_account','shared_wechat')":"channel='web_chat'"} AND created_at>NOW()-INTERVAL '10 minutes'
    ORDER BY created_at,job_id LIMIT 10`);
   let processed=0;
   for(const j of pending.rows){
    if(stopped||!enabled()||!options.adapter.enabled())break;
    await executeStoredAutomaticReception(db,{tenantId:j.tenant_id,jobId:j.job_id,messageId:j.message_id},options.adapter,
     options.defer?{defer:options.defer}:{});processed++;
   }
   return processed;
  }finally{
   if(c){let destroy=false;try{if(held)await c.query('SELECT pg_advisory_unlock(714201,$1)',[slot]);}catch{destroy=true;}c.release(destroy);}
   busy=false;
  }
 }
 return {
  tick:()=>{if(busy||stopped||!enabled())return Promise.resolve(0);const p=run();active=p;void p.finally(()=>{if(active===p)active=null;}).catch(()=>{});return p;},
  stop:async()=>{stopped=true;await active;}
 };
}
