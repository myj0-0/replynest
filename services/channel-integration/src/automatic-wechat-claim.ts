import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {loadAutomaticWeChatTarget,type AutomaticWeChatTarget} from './automatic-wechat-target.js';
import {automaticWeChatContent,copyAutomaticWeChatRequest,type AutomaticWeChatAttempt,type AutomaticWeChatClaim} from './automatic-wechat-transport.js';
import {createAutomaticWeChatNativeClient} from './automatic-wechat-native-client.js';
import type {AutomaticNativeFence} from './automatic-web-native-client.js';
import {assessStoredAutomaticEvidence} from './automatic-reception-evidence-store.js';
import {initialAiPrices} from './ai-points-core.js';
import type {ReceptionDraft} from './reception-executor.js';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';

const sha=(v:string)=>createHash('sha256').update(v,'utf8').digest('hex');
/** Real database one-attempt CAS. Explicit server-only factory, default disabled.
 * Commit the durable marker BEFORE the native RPC, never keep gateway locks during HTTP.
 * Recheck consent/routing/evidence after the native permit; no retries, no marker reopening.
 * The caller must retain the final native snapshot fence/question for this exact target.
 * This closes local races at the final gateway COMMIT, not a distributed atomic send.
 */
export function createAutomaticWeChatAttemptClaimer(db:Pick<Pool,'connect'>,options:{
 enabled?:()=>boolean;now?:()=>number;native:Pick<ReturnType<typeof createAutomaticWeChatNativeClient>,'authorize'>;
 persistEnvelope?:(c:PoolClient,l:AutomaticReceptionLease,target:AutomaticWeChatTarget['native'],content:string)=>Promise<void>;
}){
 const enabled=options.enabled??(()=>false),now=options.now??Date.now;
 async function tx<T>(work:(c:PoolClient)=>Promise<T>){
  const c=await db.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s'");await c.query("SET LOCAL lock_timeout='500ms'");
   const value=await work(c);await c.query('COMMIT');return value;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 return async(attempt:AutomaticWeChatAttempt,expected:AutomaticWeChatTarget,fence:AutomaticNativeFence):Promise<AutomaticWeChatClaim>=>{
  if(!enabled())return 'rejected';
  const copied=copyAutomaticWeChatRequest(attempt.request);
  if(!copied||automaticWeChatContent(copied)!==attempt.content||sha(attempt.content)!==attempt.contentSha256||!fence)return 'rejected';
  const r=copied;
  // Copy the server-read binding before any await; a caller mutation cannot bless a new route.
  const target=structuredClone(expected),content=attempt.content,nativeFence=structuredClone(fence);
  const l=r.lease;
  if(target.appId!==r.appId||target.openId!==r.openId||target.sourceOccurredAt!==r.sourceOccurredAt||
   target.merchantName!==(r.merchantName??null)||target.native.provider!==l.channel||target.native.accountId!==l.accountId||
   target.native.conversationId!==l.conversationId||target.native.customerId!==l.customerId||nativeFence.question_sha256!==sha(target.question))return 'rejected';
  async function validate(c:PoolClient,mark:boolean):Promise<'valid'|'rejected'|'already_attempted'>{
   if(!enabled())return 'rejected';
   const j=(await c.query(`SELECT * FROM automatic_reception_jobs WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3 FOR UPDATE`,
    [l.tenantId,l.jobId,l.workerToken])).rows[0];
   if(!j||j.state!=='submitting'||j.message_id!==l.messageId||j.account_id!==l.accountId||j.conversation_id!==l.conversationId||
    j.customer_id!==l.customerId||j.channel!==l.channel||j.connection_id!==l.connectionId||j.authorization_id!==l.authorizationId||
    j.consent_version!==l.consentVersion||j.draft?.text!==r.draftText)return 'rejected';
   if(mark&&j.transport_attempted_at!==null)return 'already_attempted';
   if(!mark&&j.transport_attempted_at===null)return 'rejected';
   const current=await loadAutomaticWeChatTarget(c,l,true);
   if(!current||JSON.stringify(current)!==JSON.stringify(target))return 'rejected';
   const clock=(await c.query('SELECT EXTRACT(EPOCH FROM clock_timestamp())*1000 now')).rows[0];
   const time=Number(clock.now);
   if(!Number.isFinite(time)||r.sourceOccurredAt>time||time-r.sourceOccurredAt>600000)return 'rejected';
   // Never permit an unmetered, guessed or unsettled generation to disclose data.
   const generation=await c.query(`SELECT 1 FROM automatic_reception_generations gen JOIN ai_usage_calls b ON b.call_id=gen.call_id
    WHERE gen.job_id=$1 AND gen.tenant_id=$2 AND gen.worker_token=$3 AND gen.state='succeeded' AND gen.attempted_at IS NOT NULL
     AND gen.reply_hash=$4 AND gen.request_key='automatic-reply:'||gen.job_id::text AND b.tenant_id=gen.tenant_id
     AND b.request_key=gen.request_key AND b.feature='copilot' AND b.model=$5 AND b.status='succeeded' FOR SHARE OF gen,b`,
    [l.jobId,l.tenantId,l.workerToken,sha(r.draftText),initialAiPrices.text.model]);
   if(generation.rowCount!==1)return 'rejected';
   const draft=j.draft as ReceptionDraft;
   if(draft.generated!==true||draft.fallback!==false||draft.requiresHumanApproval!==false)return 'rejected';
   const assessment=await assessStoredAutomaticEvidence(c,l,draft,current.question,{lock:true,now:new Date(Math.floor(time)),phase:'send'});
   const threshold=(await c.query('SELECT ai_auto_send_confidence_threshold_percent threshold FROM tenant_ai_settings WHERE tenant_id=$1 FOR SHARE',[l.tenantId])).rows[0]?.threshold;
   if(!Number.isInteger(threshold)||assessment.requiresHumanApproval||!assessment.evidenceCandidate||
    assessment.confidencePercent<Math.max(95,threshold))return 'rejected';
   if(mark){
    await options.persistEnvelope?.(c,l,current.native,content);
    const claimed=await c.query(`UPDATE automatic_reception_jobs SET transport_attempted_at=clock_timestamp()
     WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3 AND state='submitting' AND transport_attempted_at IS NULL RETURNING job_id`,
     [l.tenantId,l.jobId,l.workerToken]);
    if(claimed.rowCount!==1)return 'already_attempted';
   }
   return 'valid';
  }
  const first=await tx(c=>validate(c,true));if(first!=='valid')return first;
  // A lost reply/expired permission leaves the durable marker consumed forever.
  const permit=await options.native.authorize(target.native,l.messageId,l.jobId,content,nativeFence);
  if(permit.outcome==='uncertain')throw Error('automatic_native_permission_uncertain');
  if(permit.outcome!=='authorized')return 'rejected';
  const expiresAt=Date.parse(permit.expiresAt),at=now();
  if(!Number.isSafeInteger(expiresAt)||!Number.isSafeInteger(at)||expiresAt<=at||expiresAt-at>5000)return 'rejected';
  const second=await tx(async c=>{
   const v=await validate(c,false);
   return v==='valid'&&enabled()&&expiresAt>now()?'valid':'rejected';
  });
  if(second!=='valid'||!enabled()||expiresAt<=now())return 'rejected';
  return Object.freeze({outcome:'claimed',expiresAt});
 };
}
