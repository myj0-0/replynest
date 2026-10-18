/** Default-off server-only draft preparation. No model, timer, DDL or send.
 * Opaque per-process preparations cannot be supplied through HTTP or replayed
 * across workers. The caller must recheck before/after model and projection. */
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {StoredReceptionJob} from './reception-store.js';
import {currentReceptionHistoryGrant} from './reception-personalization.js';
import {parseLearnedReceptionStyle} from './reception-style-learning-worker.js';
import {parseReceptionTone} from './reception-presentation.js';
import {parseReceptionReplyPresentation,RECEPTION_REPLY_CONTEXT_LIMITS,type ReceptionReplyPresentation} from './reception-reply-prompt.js';
import type {AuthorizedHistorySample,AuthorizedHistoryScope} from './reception-history-reader.js';
import {redactReceptionHistoryText} from './reception-history-reader.js';
import {selectReceptionHistorySample} from './reception-history-learning.js';
type Db=Pick<Pool,'connect'>;
type Reader={read(scope:AuthorizedHistoryScope):Promise<AuthorizedHistorySample>};
type Snapshot=Readonly<{revision:string;tone:ReceptionReplyPresentation['tone'];style:string|null;contextGrant:string|null;binding:string;authorization:string}>;
type Captured={job:StoredReceptionJob;snapshot:Snapshot;sampleDigest:string|null;promptDigest:string};
export type PreparedReceptionDraft=Readonly<{presentation:ReceptionReplyPresentation}>;
export type ReceptionDraftPreparation={prepare(job:StoredReceptionJob):Promise<PreparedReceptionDraft>;
 current(prepared:PreparedReceptionDraft,options?:{rereadHistory?:boolean}):Promise<boolean>;
 commitProjection(prepared:PreparedReceptionDraft,draft:unknown):Promise<boolean>};
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const numeric=(v:unknown)=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function validateJob(j:StoredReceptionJob){
 if(!j||!uuid(j.job_id)||!uuid(j.worker_token)||!uuid(j.customer_id)||!numeric(j.account_id)||!numeric(j.conversation_id)||!numeric(j.message_id)||
  !/^[a-zA-Z0-9_-]{1,200}$/.test(j.tenant_id)||!['web_chat','shared_wechat'].includes(j.channel)||!(j.authorization_at instanceof Date)||!Number.isFinite(j.authorization_at.getTime()))
  throw Error('draft_preparation_unavailable');
}
async function transaction<T>(db:Db,run:(c:PoolClient)=>Promise<T>):Promise<T>{
 const c=await db.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='2s';SET LOCAL lock_timeout='500ms'");
  const result=await run(c);await c.query('COMMIT');return result;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
export function createReceptionDraftPreparation(db:Db,reader:Reader|undefined,options:{enabled?:()=>boolean;contextEnabled?:()=>boolean;styleEnabled?:()=>boolean}={}):ReceptionDraftPreparation {
 const enabled=options.enabled??(()=>false),contextEnabled=options.contextEnabled??(()=>false),styleEnabled=options.styleEnabled??(()=>false);
 const captures=new WeakMap<PreparedReceptionDraft,Captured>();
 const inspect=async(c:PoolClient,j:StoredReceptionJob)=>{
  if(!enabled())throw Error('draft_preparation_unavailable');
  await c.query('SELECT pg_advisory_xact_lock(714207,hashtext($1))',[j.tenant_id]);
  const live=await c.query(`SELECT to_char(j.authorization_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') authorization
   FROM reception_jobs j JOIN tenants t USING(tenant_id) JOIN tenant_ai_settings s USING(tenant_id)
   JOIN customers u ON u.tenant_id=j.tenant_id AND u.customer_id=j.customer_id
   WHERE j.tenant_id=$1 AND j.job_id=$2 AND j.worker_token=$3 AND j.state='processing'
    AND j.account_id=$4 AND j.conversation_id=$5 AND j.message_id=$6 AND j.customer_id=$7 AND j.channel=$8 AND date_trunc('milliseconds',j.authorization_at)=$9
    AND j.locked_at>clock_timestamp()-INTERVAL '2 minutes' AND t.chatwoot_account_id::text=j.account_id AND t.status IN('active','test')
    AND s.ai_auto_reply_enabled AND NOT s.automatic_sending_enabled AND s.automation_consent_version='automatic-reply-v1'
    AND s.automation_updated_at=j.authorization_at`,[j.tenant_id,j.job_id,j.worker_token,j.account_id,j.conversation_id,j.message_id,j.customer_id,j.channel,j.authorization_at]);
  if(live.rowCount!==1||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(live.rows[0]?.authorization))throw Error('draft_preparation_unavailable');
  // Bind the customer and current native conversation, not an arbitrary tenant
  // history query. Known PII/contact changes also invalidate the preparation.
  const identities=(await c.query(`SELECT DISTINCT i.chatwoot_contact_id::text contact,u.name,u.phone,u.email
   FROM channel_identities i JOIN customers u USING(tenant_id,customer_id)
   WHERE i.tenant_id=$1 AND i.customer_id=$2 AND i.channel=$3 AND i.chatwoot_conversation_id::text=$4
    AND i.sync_status='synced' AND i.chatwoot_contact_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM channel_identities x WHERE x.tenant_id=i.tenant_id AND x.chatwoot_contact_id=i.chatwoot_contact_id
      AND x.customer_id<>i.customer_id AND x.sync_status='synced') ORDER BY contact LIMIT 2`,[j.tenant_id,j.customer_id,j.channel,j.conversation_id])).rows;
  if(identities.length!==1)throw Error('draft_preparation_unavailable');
  const s=(await c.query('SELECT draft_tone,revision::text,learn_from_human FROM reception_personalization_settings WHERE tenant_id=$1',[j.tenant_id])).rows[0];
  let tone=parseReceptionTone(s?.draft_tone??'neutral'),style:string|null=null;
  if(s?.learn_from_human&&styleEnabled()){
   const p=(await c.query(`SELECT style,sample_digest,observed_at::text,profile_grant_id,profile_account_id::text,profile_settings_revision::text
    FROM reception_learned_styles WHERE tenant_id=$1 AND expires_at>clock_timestamp() AND observed_at<=clock_timestamp()+INTERVAL '5 seconds'`,[j.tenant_id])).rows[0];
   if(p&&p.profile_settings_revision===s.revision&&p.profile_account_id===j.account_id&&
    await currentReceptionHistoryGrant(c,j.tenant_id,j.account_id,'style',p.profile_grant_id)){
    try{const learned=parseLearnedReceptionStyle(p.style);if(learned.status==='suggestion'){tone=learned.tone;style=hash(p);}}catch{/* malformed aggregate uses chosen preset */}
   }
  }
  let contextGrant:string|null=null;
  if(contextEnabled()){
   if(!reader)throw Error('draft_preparation_unavailable');
   const g=(await c.query("SELECT grant_id FROM reception_history_grants WHERE tenant_id=$1 AND purpose='context' AND enabled",[j.tenant_id])).rows[0];
   if(g){if(!await currentReceptionHistoryGrant(c,j.tenant_id,j.account_id,'context',g.grant_id))throw Error('draft_preparation_unavailable');contextGrant=g.grant_id;}
  }
  if(!enabled())throw Error('draft_preparation_unavailable');
  // JS Date loses PostgreSQL microseconds. Compare millisecond input only at
  // entry, then retain the exact SQL timestamp in every later snapshot check.
  return Object.freeze({revision:s?.revision??'0',tone,style,contextGrant,binding:hash(identities),authorization:live.rows[0].authorization}) as Snapshot;
 };
 const snapshot=(j:StoredReceptionJob)=>transaction(db,c=>inspect(c,j));
 const scope=(capture:Captured):AuthorizedHistoryScope=>({tenantId:capture.job.tenant_id,accountId:capture.job.account_id,
  purpose:'context',grantId:capture.snapshot.contextGrant!,customerId:capture.job.customer_id});
 const readPrompt=async(capture:Captured)=>{
  const sample=await reader!.read(scope(capture));
  if(sample.purpose!=='context'||sample.privacyPolicy!=='history-redaction-v1'||!/^[a-f0-9]{64}$/.test(sample.sampleDigest)||
   !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(sample.asOf))throw Error('draft_preparation_unavailable');
  const rows=selectReceptionHistorySample(scope(capture),sample.messages,Date.parse(sample.asOf));
  const context:ReceptionReplyPresentation['context'][number][]=[];let characters=0;
  for(const r of rows){if(context.length>=RECEPTION_REPLY_CONTEXT_LIMITS.messages)break;
   const text=redactReceptionHistoryText(r.text);
   if(text.length>RECEPTION_REPLY_CONTEXT_LIMITS.messageCharacters||characters+text.length>RECEPTION_REPLY_CONTEXT_LIMITS.characters)continue;
   characters+=text.length;context.push(Object.freeze({direction:r.direction,text}));
  }
  return {sampleDigest:sample.sampleDigest,presentation:parseReceptionReplyPresentation({tone:capture.snapshot.tone,context:context.reverse()})};
 };
 const current:ReceptionDraftPreparation['current']=async(prepared,checks={})=>{
  const capture=captures.get(prepared);if(!capture||!enabled())return false;
  try{
   if(hash(await snapshot(capture.job))!==hash(capture.snapshot))return false;
   if(checks.rereadHistory&&capture.snapshot.contextGrant){
    const now=await readPrompt(capture);if(now.sampleDigest!==capture.sampleDigest||hash(now.presentation)!==capture.promptDigest)return false;
    if(hash(await snapshot(capture.job))!==hash(capture.snapshot))return false;
   }
   return enabled();
  }catch{return false;}
 };
 return {current,commitProjection:async(prepared,draft)=>{
  const capture=captures.get(prepared);if(!capture||!enabled())return false;
  try{return await transaction(db,async c=>{
   if(hash(await inspect(c,capture.job))!==hash(capture.snapshot)||!enabled())return false;
   const j=capture.job;
   // Linearize with settings/grant writes under the same tenant lock. Persist
   // uncertainty BEFORE the native private-note API; no retry after a crash.
   const result=await c.query(`UPDATE reception_jobs SET state='uncertain',draft=$4,reason='private_note_projection_pending',updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3 AND state='processing' RETURNING job_id`,[j.tenant_id,j.job_id,j.worker_token,draft]);
   return result.rowCount===1;
  });}catch{throw Error('draft_projection_uncertain');}
 },prepare:async raw=>{
  try{
  if(!enabled())throw Error('draft_preparation_unavailable');validateJob(raw);
  const job=Object.freeze({...raw,authorization_at:new Date(raw.authorization_at.getTime())}),initial=await snapshot(job);
  const capture:Captured={job,snapshot:initial,sampleDigest:null,promptDigest:''};
  let presentation=parseReceptionReplyPresentation({tone:initial.tone,context:[]});
  if(initial.contextGrant){const read=await readPrompt(capture);presentation=read.presentation;capture.sampleDigest=read.sampleDigest;}
  capture.promptDigest=hash(presentation);
  const prepared=Object.freeze({presentation});captures.set(prepared,capture);
  if(!await current(prepared))throw Error('draft_preparation_unavailable');return prepared;
  }catch{throw Error('draft_preparation_unavailable');}
 }};
}
