/** Server-only bounded style refresh. No timers, models, transcripts, KB facts or
 * customer sends. A caller must explicitly enable and schedule bounded batches.
 * Never hold a DB connection while reading native history. */
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {currentReceptionHistoryGrant} from './reception-personalization.js';
import {parseReceptionTone,type ReceptionTone} from './reception-presentation.js';
import type {AuthorizedHistoryScope,AuthorizedHistorySample} from './reception-history-reader.js';
import type {ReceptionLearnedStyle} from './reception-history-learning.js';
type Db=Pick<Pool,'connect'>;
type Reader={read(scope:AuthorizedHistoryScope):Promise<AuthorizedHistorySample>};
type Claim={tenant:string;account:string;grant:string;revision:string;lease:string};
const validTenant=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(v);
async function transaction<T>(db:Db,run:(c:PoolClient)=>Promise<T>):Promise<T>{
 const c=await db.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='2s';SET LOCAL lock_timeout='500ms'");
  const result=await run(c);await c.query('COMMIT');return result;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
async function fresh(c:PoolClient,claim:Claim){
 if(!await currentReceptionHistoryGrant(c,claim.tenant,claim.account,'style',claim.grant))return false;
 const r=await c.query(`SELECT 1 FROM reception_personalization_settings WHERE tenant_id=$1 AND revision=$2 AND learn_from_human`,[claim.tenant,claim.revision]);
 return r.rowCount===1;
}
/** Validate the finite aggregate again at the persistence boundary. */
export function parseLearnedReceptionStyle(value:unknown):ReceptionLearnedStyle{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_learned_style');
 const s=value as Record<string,unknown>;
 if(Object.keys(s).sort().join(',')!=='emojiRate,friendlyMarkerRate,medianReplyCharacters,politeGreetingRate,sampleConversations,sampleMessages,status,tone'||
  !['suggestion','insufficient_history'].includes(String(s.status))||!Number.isInteger(s.sampleMessages)||Number(s.sampleMessages)<0||Number(s.sampleMessages)>80||
  !Number.isInteger(s.sampleConversations)||Number(s.sampleConversations)<0||Number(s.sampleConversations)>20||Number(s.sampleConversations)>Number(s.sampleMessages)||
  typeof s.medianReplyCharacters!=='number'||!Number.isFinite(s.medianReplyCharacters)||s.medianReplyCharacters<0||s.medianReplyCharacters>2000||
  [s.politeGreetingRate,s.friendlyMarkerRate,s.emojiRate].some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>1)||
  ((Number(s.sampleMessages)>=8&&Number(s.sampleConversations)>=3)!==(s.status==='suggestion')))throw Error('invalid_learned_style');
 const tone=parseReceptionTone(s.tone);
 const expected=s.status==='insufficient_history'?'neutral':Number(s.friendlyMarkerRate)>=0.5?'friendly_detailed':
  Number(s.medianReplyCharacters)<=40&&Number(s.politeGreetingRate)<0.5&&Number(s.emojiRate)<0.25?'concise':'neutral';
 if(tone!==expected||(s.sampleMessages===0&&(s.sampleConversations!==0||s.medianReplyCharacters!==0||s.politeGreetingRate!==0||s.friendlyMarkerRate!==0||s.emojiRate!==0))||
  (Number(s.sampleMessages)>0&&Number(s.sampleConversations)===0))throw Error('invalid_learned_style');
 return Object.freeze({...s,tone}) as ReceptionLearnedStyle;
}
export function createReceptionStyleLearningWorker(db:Db,reader:Reader,options:{enabled?:()=>boolean}={}){
 const enabled=options.enabled??(()=>false);
 return {batch:async(input:{afterTenant?:string;limit?:number}={})=>{
  if(Object.keys(input).some(k=>!['afterTenant','limit'].includes(k))||(input.afterTenant!==undefined&&!validTenant(input.afterTenant))||
   (input.limit!==undefined&&(!Number.isInteger(input.limit)||input.limit<1||input.limit>20)))throw Error('invalid_style_batch');
  if(!enabled())return {state:'disabled' as const,scanned:0,refreshed:0,skipped:0,failed:0,nextTenant:null};
  const tenants=await transaction(db,async c=>(await c.query(`SELECT s.tenant_id FROM reception_personalization_settings s
   JOIN reception_history_grants g ON g.tenant_id=s.tenant_id AND g.purpose='style' AND g.enabled
   JOIN tenants t ON t.tenant_id=s.tenant_id AND t.chatwoot_account_id=g.account_id AND t.status IN('active','test')
   LEFT JOIN reception_learned_styles p ON p.tenant_id=s.tenant_id
   WHERE s.learn_from_human AND s.tenant_id>$1 AND (p.tenant_id IS NULL OR
    (p.next_attempt_at<=clock_timestamp() AND (p.lease_until IS NULL OR p.lease_until<=clock_timestamp())))
   ORDER BY s.tenant_id LIMIT $2`,[input.afterTenant??'',input.limit??5])).rows.map(r=>r.tenant_id as string));
  let refreshed=0,skipped=0,failed=0;
  for(const tenant of tenants){
   if(!enabled()){skipped++;continue;}
   let claim:Claim|null=null;
   try{
    claim=await transaction(db,async c=>{
     await c.query('SELECT pg_advisory_xact_lock(714207,hashtext($1))',[tenant]);
     const r=(await c.query(`SELECT g.account_id::text account,g.grant_id AS grant_id,s.revision::text revision FROM reception_personalization_settings s
      JOIN reception_history_grants g USING(tenant_id) WHERE s.tenant_id=$1 AND s.learn_from_human AND g.purpose='style' AND g.enabled`,[tenant])).rows[0];
     if(!r||!enabled())return null;const candidate:Claim={tenant,account:r.account,grant:r.grant_id,revision:r.revision,lease:randomUUID()};
     if(!await fresh(c,candidate))return null;
     const locked=await c.query(`INSERT INTO reception_learned_styles(tenant_id,lease_id,lease_until,next_attempt_at)
      VALUES($1,$2,clock_timestamp()+INTERVAL '2 minutes',clock_timestamp()) ON CONFLICT(tenant_id) DO UPDATE
      SET lease_id=$2,lease_until=clock_timestamp()+INTERVAL '2 minutes'
      WHERE reception_learned_styles.next_attempt_at<=clock_timestamp() AND
       (reception_learned_styles.lease_until IS NULL OR reception_learned_styles.lease_until<=clock_timestamp()) RETURNING tenant_id`,[tenant,candidate.lease]);
     return locked.rowCount===1?candidate:null;
    });
    if(!claim){skipped++;continue;}
    const captured=claim;
    const sample=await reader.read({tenantId:captured.tenant,accountId:captured.account,purpose:'style',grantId:captured.grant});
    if(sample.purpose!=='style'||!/^[a-f0-9]{64}$/.test(sample.sampleDigest)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(sample.asOf))throw Error('invalid_style_sample');
    const style=parseLearnedReceptionStyle(sample.style);
    const saved=await transaction(db,async c=>{
     await c.query('SELECT pg_advisory_xact_lock(714207,hashtext($1))',[tenant]);
     if(!enabled()||!await fresh(c,captured))return false;
     return (await c.query(`UPDATE reception_learned_styles SET style=$3,sample_digest=$4,observed_at=$5,
      expires_at=$5::timestamptz+INTERVAL '7 days',profile_grant_id=$6,profile_account_id=$7,profile_settings_revision=$8,
      lease_id=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+INTERVAL '24 hours'
      WHERE tenant_id=$1 AND lease_id=$2 AND lease_until>clock_timestamp()
       AND $5::timestamptz BETWEEN clock_timestamp()-INTERVAL '5 minutes' AND clock_timestamp()+INTERVAL '5 seconds'`,
      [tenant,captured.lease,style,sample.sampleDigest,sample.asOf,captured.grant,captured.account,captured.revision])).rowCount===1;
    });
    if(saved){refreshed++;claim=null;}else skipped++;
   }catch{failed++;}finally{
    if(claim){const captured=claim;await transaction(db,c=>c.query(`UPDATE reception_learned_styles SET lease_id=NULL,lease_until=NULL,
     next_attempt_at=clock_timestamp()+INTERVAL '15 minutes' WHERE tenant_id=$1 AND lease_id=$2`,[captured.tenant,captured.lease])).catch(()=>{});}
   }
  }
  return {state:'processed' as const,scanned:tenants.length,refreshed,skipped,failed,nextTenant:tenants.at(-1)??null};
 }};
}
/** Read at generation time, never after factual verification. Fresh grant,
 * account and settings revision must match; otherwise use the selected preset.
 * No raw human text or identity reaches a prompt. Caller must recheck grants
 * immediately before any later history-context model call or delivery. */
export async function resolveReceptionTone(db:Db,tenant:string,mode:'draft'|'automatic',options:{enabled?:()=>boolean}={}):Promise<ReceptionTone>{
 if(!validTenant(tenant)||!['draft','automatic'].includes(mode))throw Error('invalid_tone_scope');
 const enabled=options.enabled??(()=>false);if(!enabled())return 'neutral';
 return transaction(db,async c=>{
  // Linearize with configuration/grant writes. All work below is local SQL;
  // release this lock before any model/native/provider call.
  await c.query('SELECT pg_advisory_xact_lock(714207,hashtext($1))',[tenant]);
  const s=(await c.query(`SELECT draft_tone,automatic_tone,revision::text,learn_from_human FROM reception_personalization_settings WHERE tenant_id=$1`,[tenant])).rows[0];
  if(!s||!enabled())return 'neutral';
  const selected=parseReceptionTone(mode==='draft'?s.draft_tone:s.automatic_tone);if(!s.learn_from_human)return selected;
  const p=(await c.query(`SELECT style,profile_grant_id,profile_account_id::text,profile_settings_revision::text FROM reception_learned_styles
   WHERE tenant_id=$1 AND expires_at>clock_timestamp() AND observed_at<=clock_timestamp()+INTERVAL '5 seconds'`,[tenant])).rows[0];
  if(!p||p.profile_settings_revision!==s.revision)return selected;
  if(!await currentReceptionHistoryGrant(c,tenant,p.profile_account_id,'style',p.profile_grant_id)||!enabled())return selected;
  try{const style=parseLearnedReceptionStyle(p.style);return style.status==='suggestion'?style.tone:selected;}catch{return selected;}
 });
}
