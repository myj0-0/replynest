import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import type {ReceptionDraft} from './reception-executor.js';
import {loadAutomaticEvidence} from './automatic-reception-evidence-store.js';
import {automaticTextRisks} from './automatic-reception-evidence.js';
import {priceAiUsage,initialAiPrices,type AiUsage} from './ai-points-core.js';
import {currentAutomaticGenerationLease as current} from './automatic-reception-generation-lease.js';
import {loadCurrentAutomaticSemanticContexts,type AutomaticSemanticRetrieval} from './automatic-knowledge-semantic-store.js';
import {automaticSemanticQuestionAllowed,semanticGenerationSourcesAllowed,semanticGenerationMessages,parseSemanticAnswer,type SemanticStructuredAnswer} from './automatic-knowledge-grounding.js';
import {automaticSemanticPolicyAllowed} from './automatic-knowledge-verification.js';
import type {createAutomaticPresentationPreparation,PreparedAutomaticPresentation} from './reception-automatic-presentation.js';

type Db=Pick<Pool,'query'|'connect'>;
export const automaticGenerationSchema=`
 CREATE TABLE IF NOT EXISTS automatic_reception_generations(
  job_id UUID PRIMARY KEY REFERENCES automatic_reception_jobs(job_id),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  worker_token UUID NOT NULL,request_key TEXT NOT NULL UNIQUE,prompt_hash TEXT NOT NULL CHECK(prompt_hash ~ '^[a-f0-9]{64}$'),
  call_id UUID UNIQUE REFERENCES ai_usage_calls(call_id),state TEXT NOT NULL DEFAULT 'prepared'
   CHECK(state IN('prepared','reserved','requesting','succeeded','failed','uncertain')),
  attempted_at TIMESTAMPTZ,reply_hash TEXT CHECK(reply_hash ~ '^[a-f0-9]{64}$'),usage JSONB,reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK((state NOT IN('reserved','requesting','succeeded')) OR call_id IS NOT NULL),
  CHECK(state NOT IN('requesting','succeeded') OR attempted_at IS NOT NULL),
  CHECK(state<>'succeeded' OR (reply_hash IS NOT NULL AND usage IS NOT NULL))
 );
 CREATE INDEX IF NOT EXISTS automatic_generation_tenant_page ON automatic_reception_generations(tenant_id,created_at DESC,job_id);
 CREATE INDEX IF NOT EXISTS automatic_generation_stale ON automatic_reception_generations(updated_at,job_id) WHERE state IN('prepared','reserved','requesting');
 CREATE OR REPLACE FUNCTION protect_automatic_generation() RETURNS trigger AS $$
 BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'automatic generation history is immutable'; END IF;
  IF TG_OP='INSERT' THEN
   IF NEW.state<>'prepared' OR NEW.call_id IS NOT NULL OR NEW.attempted_at IS NOT NULL OR
    NEW.request_key<>'automatic-reply:'||NEW.job_id::text OR NOT EXISTS(SELECT 1 FROM automatic_reception_jobs j
     WHERE j.job_id=NEW.job_id AND j.tenant_id=NEW.tenant_id AND j.worker_token=NEW.worker_token AND j.state='processing')
    THEN RAISE EXCEPTION 'invalid automatic generation owner'; END IF;
  ELSE
   IF OLD.state IN('succeeded','failed','uncertain') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'automatic generation outcome is immutable'; END IF;
   IF ROW(NEW.job_id,NEW.tenant_id,NEW.worker_token,NEW.request_key,NEW.prompt_hash,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.job_id,OLD.tenant_id,OLD.worker_token,OLD.request_key,OLD.prompt_hash,OLD.created_at)
    THEN RAISE EXCEPTION 'automatic generation identity is immutable'; END IF;
   IF OLD.call_id IS NOT NULL AND NEW.call_id IS DISTINCT FROM OLD.call_id THEN RAISE EXCEPTION 'automatic billing identity is immutable'; END IF;
   IF NEW.call_id IS DISTINCT FROM OLD.call_id AND NOT(OLD.state='prepared' AND NEW.state='reserved')
    THEN RAISE EXCEPTION 'invalid automatic billing transition'; END IF;
   IF OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at THEN RAISE EXCEPTION 'automatic model attempt is immutable'; END IF;
   IF OLD.attempted_at IS NULL AND NEW.attempted_at IS NOT NULL AND NOT(OLD.state='reserved' AND NEW.state='requesting')
    THEN RAISE EXCEPTION 'model attempt requires reservation barrier'; END IF;
   IF NOT(OLD.state=NEW.state OR (OLD.state='prepared' AND NEW.state IN('reserved','failed','uncertain')) OR
    (OLD.state='reserved' AND NEW.state IN('requesting','failed','uncertain')) OR (OLD.state='requesting' AND NEW.state IN('succeeded','failed','uncertain')))
    THEN RAISE EXCEPTION 'invalid automatic generation transition'; END IF;
  END IF;
  IF NEW.call_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ai_usage_calls c WHERE c.call_id=NEW.call_id AND c.tenant_id=NEW.tenant_id
   AND c.request_key=NEW.request_key AND c.feature='copilot' AND c.model='${initialAiPrices.text.model}')
   THEN RAISE EXCEPTION 'invalid automatic billing owner'; END IF;
  RETURN NEW;
 END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS automatic_generation_guard ON automatic_reception_generations;
 CREATE TRIGGER automatic_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON automatic_reception_generations FOR EACH ROW EXECUTE FUNCTION protect_automatic_generation();
 CREATE OR REPLACE FUNCTION prohibit_automatic_generation_truncate() RETURNS trigger AS $$
 BEGIN RAISE EXCEPTION 'automatic generation history is immutable'; END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS automatic_generation_truncate_guard ON automatic_reception_generations;
 CREATE TRIGGER automatic_generation_truncate_guard BEFORE TRUNCATE ON automatic_reception_generations FOR EACH STATEMENT EXECUTE FUNCTION prohibit_automatic_generation_truncate();
`;
export type AutomaticGenerationPorts={
 enabled():boolean;pointsEnabled():boolean;configured():boolean;
 reserve(tenant:string,key:string,inputBound:number,outputBound:number):Promise<string>;
 settle(tenant:string,callId:string,usage:AiUsage|undefined,succeeded:boolean,errorCode?:string):Promise<void>;
 model(messages:{role:'system'|'user';content:string}[],maxTokens:number,json?:boolean):Promise<{text:string;model:string;usage:AiUsage}>;
};
export type AutomaticGenerationSemanticPorts={
 enabled():boolean;
 retrieve(l:AutomaticReceptionLease,question:string):Promise<AutomaticSemanticRetrieval|null>;
 verify(l:AutomaticReceptionLease,question:string,answer:SemanticStructuredAnswer):Promise<boolean>;
};
export type AutomaticGenerationPresentationPorts={enabled():boolean;preparation:ReturnType<typeof createAutomaticPresentationPreparation>};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export function automaticGenerationFallback():ReceptionDraft{
 return {text:'自动回复未完成，请人工查看客户问题并回复。',generated:false,fallback:true,requiresHumanApproval:true,evidenceCandidate:false,confidencePercent:0};
}
/** Worker maintenance, not an HTTP tenant API. No regeneration or assumed billing result.
 * Existing point reservations expire after 15 minutes via the normal balance maintenance.
 * Caller must drain/quiesce stalled workers before manual reconciliation or a new user question.
 */
export async function recoverAutomaticGenerations(db:Pick<Pool,'query'>,before:Date,limit=100){
 if(!(before instanceof Date)||!Number.isFinite(before.getTime())||before.getTime()>Date.now()-300000||
  !Number.isInteger(limit)||limit<1||limit>100)throw Error('invalid_automatic_generation_recovery');
 const r=await db.query(`WITH stale AS(SELECT job_id FROM automatic_reception_generations
  WHERE state IN('prepared','reserved','requesting') AND updated_at<=$1 ORDER BY updated_at,job_id LIMIT $2 FOR UPDATE SKIP LOCKED)
  UPDATE automatic_reception_generations g SET state='uncertain',reason='generation_interrupted_cost_unknown',updated_at=clock_timestamp()
  FROM stale WHERE g.job_id=stale.job_id RETURNING g.job_id`,[before,limit]);
 return r.rows.map(row=>String(row.job_id));
}
/** Ports are trusted server dependencies, never tenant/model supplied. No retry or unmetered fallback.
 * A completed generation is charged even if the reply must subsequently be reviewed by a human.
 */
export function createMeteredAutomaticGenerator(db:Db,p:AutomaticGenerationPorts,semantic?:AutomaticGenerationSemanticPorts,presentation?:AutomaticGenerationPresentationPorts){
 async function tx<T>(f:(c:PoolClient)=>Promise<T>){const c=await db.connect();try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s'");await c.query("SET LOCAL lock_timeout='500ms'");
  const result=await f(c);await c.query('COMMIT');return result;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
 async function finish(l:AutomaticReceptionLease,state:'succeeded'|'failed'|'uncertain',reason:string,reply?:string,usage?:AiUsage){
  const r=await db.query(`UPDATE automatic_reception_generations SET state=$4,reason=$5,reply_hash=$6,usage=$7,updated_at=clock_timestamp()
   WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3 AND state IN('prepared','reserved','requesting') RETURNING job_id`,
   [l.tenantId,l.jobId,l.workerToken,state,reason,reply?hash(reply):null,usage??null]);
  return r.rowCount===1;
 }
 return async(l:AutomaticReceptionLease,question:string):Promise<ReceptionDraft>=>{
  const fallback=automaticGenerationFallback();
  if(!semantic?.enabled()||!p.enabled()||!p.pointsEnabled()||!p.configured()||typeof question!=='string'||!question.trim()||question.length>4000||
   !automaticSemanticQuestionAllowed(question)||automaticTextRisks(question).length)return fallback;
  let prepared=false,callId:string|undefined,attempted=false,settlementStarted=false,style:PreparedAutomaticPresentation|undefined;
  try{
   // Knowledge retrieval is mandatory. Legacy approved answers never shortcut
   // retrieval, metering or independent verification.
   const initialEvidence=await tx(async c=>{
    if(!await current(c,l,question))return null;
    return loadAutomaticEvidence(c,l,question,{lock:true});
   });
   if(!initialEvidence||!automaticSemanticPolicyAllowed(initialEvidence)||!await semantic.retrieve(l,question))return fallback;
   const selected=await tx(async c=>{
    if(!semantic.enabled()||!p.enabled()||!p.pointsEnabled())return null;
    const fresh=await loadCurrentAutomaticSemanticContexts(c,l,question);if(!fresh)return null;
    const input=await loadAutomaticEvidence(c,l,question,{lock:true});
    return input.evidenceRevision===fresh.sourceRevision&&automaticSemanticPolicyAllowed(input)?fresh:null;
   });
   if(!selected?.contexts.length||!semanticGenerationSourcesAllowed(selected.contexts))return fallback;
   if(presentation?.enabled()){
    // Style can never replace current knowledge or independent verification.
    style=await presentation.preparation.prepare(l,question);
    if(!await presentation.preparation.current(style))return fallback;
   }
   const contexts=selected.contexts;
   const messages=semanticGenerationMessages(question,contexts,style?.data);
   const serialized=JSON.stringify(messages),key=`automatic-reply:${l.jobId}`,maxTokens=1500;
   if(Buffer.byteLength(serialized)>40000)return fallback;
   if(style&&(!presentation?.enabled()||!await presentation.preparation.current(style)))return fallback;
   prepared=await tx(async c=>{
    if(!p.enabled()||!p.pointsEnabled()||!await current(c,l,question))return false;
    if(style&&(!presentation?.enabled()||!await presentation.preparation.currentInTransaction(c,style)))return false;
    if(selected){
     if(!semantic?.enabled())return false;
     const fresh=await loadCurrentAutomaticSemanticContexts(c,l,question);
     if(!fresh||fresh.sourceRevision!==selected.sourceRevision)return false;
    }
    return (await c.query(`INSERT INTO automatic_reception_generations(job_id,tenant_id,worker_token,request_key,prompt_hash)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING job_id`,[l.jobId,l.tenantId,l.workerToken,key,hash(serialized)])).rowCount===1;
   });
   if(!prepared)return fallback;
   // UTF-8 bytes are a conservative token bound, with fixed provider overhead allowance.
   callId=await p.reserve(l.tenantId,key,Buffer.byteLength(serialized)+4096,maxTokens);
   const reserved=await db.query(`UPDATE automatic_reception_generations SET call_id=$4,state='reserved',updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3 AND state='prepared' RETURNING job_id`,[l.tenantId,l.jobId,l.workerToken,callId]);
   if(reserved.rowCount!==1)throw Error('generation_reservation_binding_failed');
   const presentationCurrent=!style||!!presentation?.enabled()&&await presentation.preparation.current(style);
   const barrier=presentationCurrent&&await tx(async c=>{
    if(!p.enabled()||!p.pointsEnabled()||!await current(c,l,question))return false;
    if(style&&(!presentation?.enabled()||!await presentation.preparation.currentInTransaction(c,style)))return false;
    const latestEvidence=await loadAutomaticEvidence(c,l,question,{lock:true});
    if(selected){
     if(!semantic?.enabled()||!automaticSemanticPolicyAllowed(latestEvidence)||latestEvidence.evidenceRevision!==selected.sourceRevision)return false;
     const fresh=await loadCurrentAutomaticSemanticContexts(c,l,question);
     if(!fresh||fresh.sourceRevision!==selected.sourceRevision||JSON.stringify(fresh.contexts.map(c=>c.proof))!==JSON.stringify(selected.contexts.map(c=>c.proof)))return false;
    }
    const call=await c.query(`SELECT 1 FROM ai_usage_calls WHERE tenant_id=$1 AND call_id=$2 AND request_key=$3 AND status='reserved'
     AND model=$4 AND feature='copilot' AND created_at>NOW()-INTERVAL '2 minutes' FOR SHARE`,[l.tenantId,callId,key,initialAiPrices.text.model]);
    if(call.rowCount!==1)return false;
    const r=await c.query(`UPDATE automatic_reception_generations SET state='requesting',attempted_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3 AND state='reserved' AND attempted_at IS NULL RETURNING job_id`,[l.tenantId,l.jobId,l.workerToken]);
    return r.rowCount===1;
   });
   if(!barrier){settlementStarted=true;await p.settle(l.tenantId,callId,undefined,false,'automatic_generation_cancelled');await finish(l,'failed','authorization_or_reservation_changed');return fallback;}
   attempted=true;
   let output:{text:string;model:string;usage:AiUsage}|undefined,usage:AiUsage|undefined,modelReason='generated';
   try{output=await p.model(messages,maxTokens,true);usage=output.usage;}
   catch(error){
    // Only whitelisted structured error codes and bounded usage; never persist raw errors.
    const e=error as {code?:string;usage?:AiUsage};usage=e?.usage;
    modelReason=['qwen_auth_failed','qwen_rate_limited','qwen_input_limit','qwen_not_configured','qwen_configuration_invalid'].includes(e?.code??'')?'provider_rejected':'provider_outcome_uncertain';
   }
   if(usage)priceAiUsage(usage,initialAiPrices.text); // rejects forged/invalid usage before billing
   settlementStarted=true;
   await p.settle(l.tenantId,callId,usage,!!usage,usage?undefined:modelReason==='provider_rejected'?'automatic_provider_rejected':'automatic_provider_cost_unknown');
   // settle() can be a no-op for an expired reservation. Require the actual persisted receipt.
   const bill=(await db.query(`SELECT status,input_tokens,output_tokens,cached_input_tokens FROM ai_usage_calls WHERE tenant_id=$1 AND call_id=$2`,[l.tenantId,callId])).rows[0];
   if(!usage||bill?.status!=='succeeded'||Number(bill.input_tokens)!==usage.input_tokens||Number(bill.output_tokens)!==usage.output_tokens||Number(bill.cached_input_tokens)!==usage.cached_input_tokens){
    await finish(l,modelReason==='provider_rejected'?'failed':'uncertain',usage?'billing_receipt_unavailable':modelReason);return fallback;
   }
   if(!output||output.model!==initialAiPrices.text.model||typeof output.text!=='string'||!output.text.trim()||output.text.length>24000){
    await finish(l,'failed','invalid_output_billed');return fallback;
   }
   if(style&&(!presentation?.enabled()||!await presentation.preparation.current(style,true))){
    await finish(l,'failed','presentation_changed_billed');return fallback;
   }
   {
    const answer=parseSemanticAnswer(output.text,question,contexts);
    if(!answer){await finish(l,'failed','invalid_grounding_billed');return fallback;}
    if(!await finish(l,'succeeded',style?'semantic_styled_generated':'semantic_generated',answer.text,usage))return fallback;
    const verified=!!semantic?.enabled()&&p.enabled()&&await semantic.verify(l,question,answer);
    const stillCurrent=!style||!!presentation?.enabled()&&await presentation.preparation.current(style);
    return {text:answer.text,generated:true,fallback:false,requiresHumanApproval:!verified||!stillCurrent||!p.enabled()||!semantic?.enabled(),
     evidenceCandidate:verified&&stillCurrent,confidencePercent:verified&&stillCurrent?95:0};
   }
  }catch(error){
   // COMMIT acknowledgement may have been lost. Never retry a reservation, model or settlement.
   if(callId&&!settlementStarted){await p.settle(l.tenantId,callId,undefined,false,attempted?'automatic_provider_cost_unknown':'automatic_generation_cancelled').catch(()=>{});}
   const insufficient=!callId&&(error as {code?:string})?.code==='ai_points_insufficient';
   if(prepared)await finish(l,insufficient?'failed':'uncertain',insufficient?'points_insufficient':settlementStarted?'billing_outcome_uncertain':attempted?'provider_outcome_uncertain':'reservation_outcome_uncertain').catch(()=>{});
   return fallback;
  }
 };
}
