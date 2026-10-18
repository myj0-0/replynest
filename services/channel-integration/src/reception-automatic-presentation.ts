/** Server-only presentation journal for automatic replies. No model or send.
 * A journal row is NOT evidence, a send grant, or a due queue. It binds the
 * actual preparation before model use to later verification/submit guards. */
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import {currentAutomaticGenerationLease} from './automatic-reception-generation-lease.js';
import {automaticEvidenceRevision} from './automatic-reception-revision.js';
import {currentReceptionHistoryGrant} from './reception-personalization.js';
import {parseLearnedReceptionStyle} from './reception-style-learning-worker.js';
import {parseReceptionTone,parseReceptionTiming,defaultReceptionTiming,type ReceptionTiming} from './reception-presentation.js';
import {parseReceptionReplyPresentation,RECEPTION_REPLY_CONTEXT_LIMITS,type ReceptionReplyPresentation} from './reception-reply-prompt.js';
import {selectReceptionHistorySample} from './reception-history-learning.js';
import {redactReceptionHistoryText,type AuthorizedHistorySample,type AuthorizedHistoryScope} from './reception-history-reader.js';
type Db=Pick<Pool,'connect'>;
type Reader={read(scope:AuthorizedHistoryScope):Promise<AuthorizedHistorySample>};
type Query=Pick<PoolClient,'query'>;
export type AutomaticPresentationOptions={enabled?:()=>boolean;contextEnabled?:()=>boolean;styleEnabled?:()=>boolean};
/** Server configuration only. No tenant/model value can turn a release gate on. */
export function automaticPresentationOptionsFromEnv():AutomaticPresentationOptions {
 return {enabled:()=>process.env.AI_RECEPTION_AUTOMATIC_PRESENTATION_ENABLED==='true',
  contextEnabled:()=>process.env.AI_RECEPTION_HISTORY_READ_ENABLED==='true'&&process.env.AI_RECEPTION_HISTORY_CONTEXT_ENABLED==='true',
  styleEnabled:()=>process.env.AI_RECEPTION_HISTORY_READ_ENABLED==='true'&&process.env.AI_RECEPTION_STYLE_LEARNING_ENABLED==='true'};
}
type Snapshot=Readonly<{revision:string;sourceRevision:string;tone:ReceptionReplyPresentation['tone'];timing:ReceptionTiming;binding:string;
 contextEnabled:boolean;styleEnabled:boolean;contextGrant:string|null;styleGrant:string|null;styleDigest:string|null}>;
export type PreparedAutomaticPresentation=Readonly<{data:ReceptionReplyPresentation;timing:ReceptionTiming}>;
type Capture={lease:AutomaticReceptionLease;question:string;snapshot:Snapshot;historyDigest:string|null;presentationHash:string};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const questionHash=(q:string)=>createHash('sha256').update(q).digest('hex');
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const id=(v:unknown)=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
function validate(l:AutomaticReceptionLease,q:string){
 if(!l||!uuid(l.jobId)||!uuid(l.workerToken)||!uuid(l.customerId)||!uuid(l.authorizationId)||!id(l.accountId)||!id(l.conversationId)||!id(l.messageId)||
  !/^[a-zA-Z0-9_-]{1,200}$/.test(l.tenantId)||!['web_chat','wechat_official_account','shared_wechat'].includes(l.channel)||
  (l.channel==='shared_wechat'?l.connectionId!==null:!uuid(l.connectionId))||l.consentVersion!=='automatic-send-v1'||
  typeof q!=='string'||!q.trim()||q.length>4000)throw Error('automatic_presentation_unavailable');
}
export const automaticPresentationSchema=`
 CREATE TABLE automatic_reception_presentations(
  job_id UUID PRIMARY KEY REFERENCES automatic_reception_jobs(job_id),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  worker_token UUID NOT NULL,account_id TEXT NOT NULL,customer_id UUID NOT NULL,
  question_hash TEXT NOT NULL CHECK(question_hash ~ '^[a-f0-9]{64}$'),
  presentation_hash TEXT NOT NULL CHECK(presentation_hash ~ '^[a-f0-9]{64}$'),
  settings_revision BIGINT NOT NULL CHECK(settings_revision>=0),tone TEXT NOT NULL CHECK(tone IN('concise','neutral','friendly_detailed')),
  source_revision TEXT NOT NULL CHECK(source_revision ~ '^[0-9]{1,19}$'),
  timing_enabled BOOLEAN NOT NULL,minimum_seconds INTEGER NOT NULL CHECK(minimum_seconds>=1),
  maximum_seconds INTEGER NOT NULL CHECK(maximum_seconds<=120 AND maximum_seconds>minimum_seconds),
  binding_hash TEXT NOT NULL CHECK(binding_hash ~ '^[a-f0-9]{64}$'),context_enabled BOOLEAN NOT NULL,style_enabled BOOLEAN NOT NULL,
  context_grant_id UUID,history_digest TEXT CHECK(history_digest ~ '^[a-f0-9]{64}$'),
  style_grant_id UUID,style_digest TEXT CHECK(style_digest ~ '^[a-f0-9]{64}$'),
  version TEXT NOT NULL DEFAULT 'automatic-presentation-v1' CHECK(version='automatic-presentation-v1'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK((context_grant_id IS NULL)=(history_digest IS NULL)),CHECK(context_enabled OR context_grant_id IS NULL),
  CHECK((style_grant_id IS NULL)=(style_digest IS NULL)),CHECK(style_enabled OR style_grant_id IS NULL)
 );
 CREATE INDEX automatic_presentation_tenant_page ON automatic_reception_presentations(tenant_id,created_at DESC,job_id);
 CREATE FUNCTION guard_automatic_presentation() RETURNS trigger AS $$
 BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'automatic presentation history is immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM automatic_reception_jobs j WHERE j.job_id=NEW.job_id AND j.tenant_id=NEW.tenant_id
   AND j.worker_token=NEW.worker_token AND j.account_id=NEW.account_id AND j.customer_id=NEW.customer_id AND j.state='processing'
   AND j.locked_at>clock_timestamp()-INTERVAL '2 minutes') THEN RAISE EXCEPTION 'invalid automatic presentation owner'; END IF;
  IF NEW.context_grant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reception_history_grants g WHERE g.tenant_id=NEW.tenant_id
   AND g.account_id::text=NEW.account_id AND g.grant_id=NEW.context_grant_id AND g.enabled AND g.purpose='context'
   AND g.disclosure_version='reception-history-context-v1') THEN RAISE EXCEPTION 'invalid automatic presentation context'; END IF;
  IF NEW.style_grant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reception_history_grants g WHERE g.tenant_id=NEW.tenant_id
   AND g.account_id::text=NEW.account_id AND g.grant_id=NEW.style_grant_id AND g.enabled AND g.purpose='style'
   AND g.disclosure_version='reception-history-style-v1') THEN RAISE EXCEPTION 'invalid automatic presentation style'; END IF;
  IF EXISTS(SELECT 1 FROM reception_personalization_settings s WHERE s.tenant_id=NEW.tenant_id AND s.revision<>NEW.settings_revision)
   OR (NEW.settings_revision<>0 AND NOT EXISTS(SELECT 1 FROM reception_personalization_settings s WHERE s.tenant_id=NEW.tenant_id))
   THEN RAISE EXCEPTION 'invalid automatic presentation revision'; END IF;
  IF NOT EXISTS(SELECT 1 FROM automatic_reception_revisions r WHERE r.tenant_id=NEW.tenant_id AND r.revision::text=NEW.source_revision)
   THEN RAISE EXCEPTION 'invalid automatic presentation source revision'; END IF;
  RETURN NEW;
 END; $$ LANGUAGE plpgsql;
 CREATE TRIGGER automatic_presentation_guard BEFORE INSERT OR UPDATE OR DELETE ON automatic_reception_presentations
  FOR EACH ROW EXECUTE FUNCTION guard_automatic_presentation();
 CREATE TRIGGER automatic_presentation_truncate_guard BEFORE TRUNCATE ON automatic_reception_presentations
  FOR EACH STATEMENT EXECUTE FUNCTION guard_automatic_presentation();
`;
export function automaticPresentationRuntimeAcl(runtime:string){
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(runtime))throw Error('invalid_presentation_runtime_role');
 return `REVOKE ALL ON TABLE public.automatic_reception_presentations FROM PUBLIC,"${runtime}";
  GRANT SELECT,INSERT ON TABLE public.automatic_reception_presentations TO "${runtime}";
  REVOKE ALL ON FUNCTION public.guard_automatic_presentation() FROM PUBLIC,"${runtime}";
  GRANT EXECUTE ON FUNCTION public.guard_automatic_presentation() TO "${runtime}";`;
}
/** SQL only. Caller owns a bounded transaction; release before any native/model
 * I/O. Grant/job locking precedes the shared tenant personalization lock. */
async function currentSnapshot(c:Query,l:AutomaticReceptionLease,q:string,o:AutomaticPresentationOptions,phase:'generation'|'send'){
 if(!o.enabled?.()||!await currentAutomaticGenerationLease(c,l,q,phase))return null;
 await c.query('SELECT pg_advisory_xact_lock(714207,hashtext($1))',[l.tenantId]);
 const rows=(await c.query(`SELECT DISTINCT i.chatwoot_contact_id::text contact,u.name,u.email,u.phone FROM channel_identities i
  JOIN customers u USING(tenant_id,customer_id) WHERE i.tenant_id=$1 AND i.customer_id=$2 AND i.channel=$3
   AND i.chatwoot_conversation_id::text=$4 AND i.channel_connection_id IS NOT DISTINCT FROM $5::uuid AND i.sync_status='synced'
   AND i.chatwoot_contact_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM channel_identities x WHERE x.tenant_id=i.tenant_id
    AND x.chatwoot_contact_id=i.chatwoot_contact_id AND x.customer_id<>i.customer_id AND x.sync_status='synced') ORDER BY contact LIMIT 2`,
  [l.tenantId,l.customerId,l.channel,l.conversationId,l.connectionId])).rows;
 if(rows.length!==1)return null;
 const s=(await c.query(`SELECT revision::text,automatic_tone,learn_from_human,timing_enabled,minimum_seconds,maximum_seconds
  FROM reception_personalization_settings WHERE tenant_id=$1`,[l.tenantId])).rows[0];
 let tone=parseReceptionTone(s?.automatic_tone??'neutral'),styleGrant:string|null=null,styleDigest:string|null=null;
 const timing=s?parseReceptionTiming({enabled:s.timing_enabled,minimumSeconds:s.minimum_seconds,maximumSeconds:s.maximum_seconds}):defaultReceptionTiming;
 const contextEnabled=!!o.contextEnabled?.(),styleEnabled=!!o.styleEnabled?.();
 if(s?.learn_from_human&&styleEnabled){
  const p=(await c.query(`SELECT style,sample_digest,observed_at::text,profile_grant_id,profile_account_id::text,profile_settings_revision::text
   FROM reception_learned_styles WHERE tenant_id=$1 AND expires_at>clock_timestamp() AND observed_at<=clock_timestamp()+INTERVAL '5 seconds'`,[l.tenantId])).rows[0];
  if(p&&p.profile_settings_revision===s.revision&&p.profile_account_id===l.accountId&&await currentReceptionHistoryGrant(c,l.tenantId,l.accountId,'style',p.profile_grant_id)){
   try{const learned=parseLearnedReceptionStyle(p.style);if(learned.status==='suggestion'){tone=learned.tone;styleGrant=p.profile_grant_id;styleDigest=hash(p);}}catch{/* use chosen preset */}
  }
 }
 let contextGrant:string|null=null;
 if(contextEnabled){const g=(await c.query("SELECT grant_id FROM reception_history_grants WHERE tenant_id=$1 AND purpose='context' AND enabled",[l.tenantId])).rows[0];
  if(g){if(!await currentReceptionHistoryGrant(c,l.tenantId,l.accountId,'context',g.grant_id))return null;contextGrant=g.grant_id;}}
 const sourceRevision=await automaticEvidenceRevision(c,l.tenantId,true);
 return o.enabled?.()?Object.freeze({revision:s?.revision??'0',sourceRevision,tone,timing,binding:hash(rows),contextEnabled,styleEnabled,contextGrant,styleGrant,styleDigest}) as Snapshot:null;
}
function rowSnapshot(row:any):Snapshot {
 return {revision:row.settings_revision,sourceRevision:row.source_revision,tone:parseReceptionTone(row.tone),timing:parseReceptionTiming({enabled:row.timing_enabled,minimumSeconds:row.minimum_seconds,maximumSeconds:row.maximum_seconds}),
  binding:row.binding_hash,contextEnabled:row.context_enabled,styleEnabled:row.style_enabled,contextGrant:row.context_grant_id,styleGrant:row.style_grant_id,styleDigest:row.style_digest};
}
/** Final SQL guard. No transcript reread inside a send transaction. Facts are
 * independently verified from current knowledge, never from history. */
export async function currentStoredAutomaticPresentation(c:Query,l:AutomaticReceptionLease,q:string,o:AutomaticPresentationOptions={},phase:'generation'|'send'='generation'){
 if(!o.enabled?.())return false;
 const fresh=await currentSnapshot(c,l,q,o,phase);if(!fresh)return false;
 const row=(await c.query(`SELECT settings_revision::text,source_revision,tone,timing_enabled,minimum_seconds,maximum_seconds,binding_hash,
  context_enabled,style_enabled,context_grant_id,style_grant_id,style_digest FROM automatic_reception_presentations
  WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3 AND account_id=$4 AND customer_id=$5 AND question_hash=$6 AND version='automatic-presentation-v1'`,
  [l.tenantId,l.jobId,l.workerToken,l.accountId,l.customerId,questionHash(q)])).rows[0];
 return !!row&&hash(rowSnapshot(row))===hash(fresh)&&!!o.enabled?.();
}
export function createAutomaticPresentationPreparation(db:Db,reader:Reader|undefined,options:AutomaticPresentationOptions={}){
 const captures=new WeakMap<PreparedAutomaticPresentation,Capture>();
 const tx=async<T>(run:(c:PoolClient)=>Promise<T>)=>{const c=await db.connect();try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s';SET LOCAL lock_timeout='500ms'");
  const value=await run(c);await c.query('COMMIT');return value;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}};
 const read=async(capture:Capture)=>{
  if(!reader||!options.enabled?.()||!options.contextEnabled?.())throw Error('automatic_presentation_unavailable');
  const l=capture.lease,scope:AuthorizedHistoryScope={tenantId:l.tenantId,accountId:l.accountId,customerId:l.customerId,purpose:'context',grantId:capture.snapshot.contextGrant!};
  const sample=await reader.read(scope);
  if(sample.purpose!=='context'||sample.privacyPolicy!=='history-redaction-v1'||!/^[a-f0-9]{64}$/.test(sample.sampleDigest)||
   !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(sample.asOf))throw Error('automatic_presentation_unavailable');
  const rows=selectReceptionHistorySample(scope,sample.messages,Date.parse(sample.asOf));
  const context:ReceptionReplyPresentation['context'][number][]=[];let characters=0;
  for(const row of rows){if(context.length>=RECEPTION_REPLY_CONTEXT_LIMITS.messages)break;const text=redactReceptionHistoryText(row.text);
   if(text.length>RECEPTION_REPLY_CONTEXT_LIMITS.messageCharacters||characters+text.length>RECEPTION_REPLY_CONTEXT_LIMITS.characters)continue;
   characters+=text.length;context.push(Object.freeze({direction:row.direction,text}));}
  return {data:parseReceptionReplyPresentation({tone:capture.snapshot.tone,context:context.reverse()}),historyDigest:sample.sampleDigest};
 };
 const current=async(prepared:PreparedAutomaticPresentation,rereadHistory=false)=>{
  const capture=captures.get(prepared);if(!capture||!options.enabled?.())return false;
  try{
   if(!await tx(c=>currentStoredAutomaticPresentation(c,capture.lease,capture.question,options)))return false;
   if(rereadHistory&&capture.snapshot.contextGrant){const fresh=await read(capture);
    if(fresh.historyDigest!==capture.historyDigest||hash(fresh.data)!==capture.presentationHash)return false;
    if(!await tx(c=>currentStoredAutomaticPresentation(c,capture.lease,capture.question,options)))return false;}
   return !!options.enabled?.();
  }catch{return false;}
 };
 return {current,
 /** Resume after a durable wait/restart without creating a preparation or a
  * new model/point receipt. Read transcript outside SQL locks; compare the same
  * bounded, redacted sample and prompt hash used before original generation. */
 currentStored:async(l:AutomaticReceptionLease,q:string)=>{
  if(!options.enabled?.())return false;
  try{
   validate(l,q);
   const capture=await tx(async c=>{
    if(!await currentStoredAutomaticPresentation(c,l,q,options))return null;
    const row=(await c.query(`SELECT settings_revision::text,source_revision,tone,timing_enabled,minimum_seconds,maximum_seconds,binding_hash,
     context_enabled,style_enabled,context_grant_id,style_grant_id,style_digest,history_digest,presentation_hash
     FROM automatic_reception_presentations WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3 AND question_hash=$4`,
     [l.tenantId,l.jobId,l.workerToken,questionHash(q)])).rows[0];
    return row?{lease:l,question:q,snapshot:rowSnapshot(row),historyDigest:row.history_digest,presentationHash:row.presentation_hash} as Capture:null;
   });
   if(!capture)return false;
   if(capture.snapshot.contextGrant){const fresh=await read(capture);
    if(fresh.historyDigest!==capture.historyDigest||hash(fresh.data)!==capture.presentationHash)return false;}
   return await tx(c=>currentStoredAutomaticPresentation(c,l,q,options));
  }catch{return false;}
 },currentInTransaction:async(c:Query,prepared:PreparedAutomaticPresentation)=>{
  const capture=captures.get(prepared);if(!capture||!options.enabled?.())return false;
  return currentStoredAutomaticPresentation(c,capture.lease,capture.question,options);
 },prepare:async(raw:AutomaticReceptionLease,q:string):Promise<PreparedAutomaticPresentation>=>{
  try{
   if(!options.enabled?.())throw Error();validate(raw,q);const lease=Object.freeze({...raw});
   const snapshot=await tx(c=>currentSnapshot(c,lease,q,options,'generation'));if(!snapshot)throw Error();
   const capture:Capture={lease,question:q,snapshot,historyDigest:null,presentationHash:''};
   let data=parseReceptionReplyPresentation({tone:snapshot.tone,context:[]});
   if(snapshot.contextGrant){const sample=await read(capture);data=sample.data;capture.historyDigest=sample.historyDigest;}
   capture.presentationHash=hash(data);
   const saved=await tx(async c=>{
    const fresh=await currentSnapshot(c,lease,q,options,'generation');if(!fresh||hash(fresh)!==hash(snapshot))return false;
    return (await c.query(`INSERT INTO automatic_reception_presentations(job_id,tenant_id,worker_token,account_id,customer_id,question_hash,presentation_hash,
     settings_revision,tone,timing_enabled,minimum_seconds,maximum_seconds,binding_hash,context_enabled,style_enabled,context_grant_id,history_digest,style_grant_id,style_digest,source_revision)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT DO NOTHING RETURNING job_id`,
     [lease.jobId,lease.tenantId,lease.workerToken,lease.accountId,lease.customerId,questionHash(q),capture.presentationHash,snapshot.revision,snapshot.tone,
      snapshot.timing.enabled,snapshot.timing.minimumSeconds,snapshot.timing.maximumSeconds,snapshot.binding,snapshot.contextEnabled,snapshot.styleEnabled,
      snapshot.contextGrant,capture.historyDigest,snapshot.styleGrant,snapshot.styleDigest,snapshot.sourceRevision])).rowCount===1;
   });if(!saved)throw Error();
   const prepared=Object.freeze({data,timing:snapshot.timing});captures.set(prepared,capture);
   if(!await current(prepared))throw Error();return prepared;
  }catch{throw Error('automatic_presentation_unavailable');}
 }};
}
