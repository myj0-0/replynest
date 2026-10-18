import type {Pool,PoolClient} from 'pg';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import type {AutomaticGenerationPorts} from './automatic-reception-generation.js';
import {loadAutomaticEvidence} from './automatic-reception-evidence-store.js';
import {automaticPolicyDecision,automaticTextRisks,assessAutomaticEvidence,AUTOMATIC_SEMANTIC_EVIDENCE_VERSION,
 type AutomaticEvidenceAssessment} from './automatic-reception-evidence.js';
import {loadCurrentAutomaticSemanticContexts} from './automatic-knowledge-semantic-store.js';
import {semanticHash} from './automatic-knowledge-semantic.js';
import {automaticSemanticQuestionAllowed,revalidateSemanticAnswer,semanticVerificationMessages,parseSemanticVerdict,
 semanticVerdictPassed,SEMANTIC_GROUNDING_VERSION,type SemanticStructuredAnswer,type SemanticVerdict} from './automatic-knowledge-grounding.js';
import {initialAiPrices,priceAiUsage,type AiUsage} from './ai-points-core.js';
import {currentStoredAutomaticPresentation,automaticPresentationOptionsFromEnv,type AutomaticPresentationOptions} from './reception-automatic-presentation.js';

type Db=Pick<Pool,'query'|'connect'>;
/** Explicit owner migration, installed together with the semantic retrieval component.
 * Raw questions, answers and quotes are NOT duplicated in this journal. Every model
 * attempt has its own fixed request key, actual usage receipt and immutable outcome. */
export const automaticSemanticVerificationSchema=`
 CREATE TABLE IF NOT EXISTS automatic_reception_verifications(
  job_id UUID PRIMARY KEY REFERENCES automatic_reception_generations(job_id),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  worker_token UUID NOT NULL,request_key TEXT NOT NULL UNIQUE,prompt_hash TEXT NOT NULL CHECK(prompt_hash ~ '^[a-f0-9]{64}$'),
  question_hash TEXT NOT NULL CHECK(question_hash ~ '^[a-f0-9]{64}$'),reply_hash TEXT NOT NULL CHECK(reply_hash ~ '^[a-f0-9]{64}$'),
  source_revision TEXT NOT NULL CHECK(source_revision ~ '^[0-9]{1,19}$'),claims JSONB NOT NULL,
  grounding_version TEXT NOT NULL CHECK(grounding_version='${SEMANTIC_GROUNDING_VERSION}'),
  call_id UUID UNIQUE REFERENCES ai_usage_calls(call_id),state TEXT NOT NULL DEFAULT 'prepared'
   CHECK(state IN('prepared','reserved','requesting','succeeded','failed','uncertain')),
  attempted_at TIMESTAMPTZ,usage JSONB,verdict JSONB,reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(jsonb_typeof(claims)='array' AND jsonb_array_length(claims) BETWEEN 1 AND 8 AND octet_length(claims::text)<=8192),
  CHECK(state NOT IN('reserved','requesting','succeeded') OR call_id IS NOT NULL),
  CHECK(state NOT IN('requesting','succeeded') OR attempted_at IS NOT NULL),
  CHECK(state<>'succeeded' OR (usage IS NOT NULL AND verdict IS NOT NULL)),
  CHECK(verdict IS NULL OR (jsonb_typeof(verdict)='object' AND octet_length(verdict::text)<=8192))
 );
 CREATE INDEX IF NOT EXISTS automatic_verification_stale ON automatic_reception_verifications(updated_at,job_id) WHERE state IN('prepared','reserved','requesting');
 CREATE INDEX IF NOT EXISTS automatic_verification_tenant_page ON automatic_reception_verifications(tenant_id,created_at DESC,job_id);
 CREATE OR REPLACE FUNCTION protect_automatic_verification() RETURNS trigger AS $$
 BEGIN
  IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'automatic verification history is immutable'; END IF;
  IF TG_OP='INSERT' THEN
   IF NEW.state<>'prepared' OR NEW.call_id IS NOT NULL OR NEW.attempted_at IS NOT NULL OR NEW.usage IS NOT NULL OR NEW.verdict IS NOT NULL OR
    NEW.request_key<>'automatic-verify:'||NEW.job_id::text OR NOT EXISTS(SELECT 1 FROM automatic_reception_jobs j
     JOIN automatic_reception_generations g ON g.job_id=j.job_id AND g.tenant_id=j.tenant_id AND g.worker_token=j.worker_token
     WHERE j.job_id=NEW.job_id AND j.tenant_id=NEW.tenant_id AND j.worker_token=NEW.worker_token AND j.state='processing'
      AND g.state='succeeded' AND g.reply_hash=NEW.reply_hash)
    THEN RAISE EXCEPTION 'invalid automatic verification owner'; END IF;
  ELSE
   IF OLD.state IN('succeeded','failed','uncertain') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'automatic verification outcome is immutable'; END IF;
   IF ROW(NEW.job_id,NEW.tenant_id,NEW.worker_token,NEW.request_key,NEW.prompt_hash,NEW.question_hash,NEW.reply_hash,NEW.source_revision,NEW.claims,NEW.grounding_version,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.job_id,OLD.tenant_id,OLD.worker_token,OLD.request_key,OLD.prompt_hash,OLD.question_hash,OLD.reply_hash,OLD.source_revision,OLD.claims,OLD.grounding_version,OLD.created_at)
    THEN RAISE EXCEPTION 'automatic verification identity is immutable'; END IF;
   IF OLD.call_id IS NOT NULL AND NEW.call_id IS DISTINCT FROM OLD.call_id THEN RAISE EXCEPTION 'automatic verification billing identity is immutable'; END IF;
   IF NEW.call_id IS DISTINCT FROM OLD.call_id AND NOT(OLD.state='prepared' AND NEW.state='reserved') THEN RAISE EXCEPTION 'invalid verification billing transition'; END IF;
   IF OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at THEN RAISE EXCEPTION 'automatic verification attempt is immutable'; END IF;
   IF OLD.attempted_at IS NULL AND NEW.attempted_at IS NOT NULL AND NOT(OLD.state='reserved' AND NEW.state='requesting') THEN RAISE EXCEPTION 'verification attempt requires reservation barrier'; END IF;
   IF NOT(OLD.state=NEW.state OR (OLD.state='prepared' AND NEW.state IN('reserved','failed','uncertain')) OR
    (OLD.state='reserved' AND NEW.state IN('requesting','failed','uncertain')) OR (OLD.state='requesting' AND NEW.state IN('succeeded','failed','uncertain')))
    THEN RAISE EXCEPTION 'invalid automatic verification transition'; END IF;
   IF ROW(NEW.usage,NEW.verdict) IS DISTINCT FROM ROW(OLD.usage,OLD.verdict) AND NOT(OLD.state='requesting' AND NEW.state='succeeded')
    THEN RAISE EXCEPTION 'verification result requires completed attempt'; END IF;
  END IF;
  IF NEW.call_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ai_usage_calls c WHERE c.call_id=NEW.call_id AND c.tenant_id=NEW.tenant_id
   AND c.request_key=NEW.request_key AND c.feature='copilot' AND c.model='${initialAiPrices.text.model}') THEN RAISE EXCEPTION 'invalid automatic verification billing owner'; END IF;
  IF NEW.state='succeeded' AND NOT EXISTS(SELECT 1 FROM ai_usage_calls c WHERE c.call_id=NEW.call_id AND c.tenant_id=NEW.tenant_id
   AND c.status='succeeded' AND c.input_tokens::text=NEW.usage->>'input_tokens' AND c.output_tokens::text=NEW.usage->>'output_tokens'
   AND c.cached_input_tokens::text=NEW.usage->>'cached_input_tokens') THEN RAISE EXCEPTION 'automatic verification billing receipt required'; END IF;
  RETURN NEW;
 END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS automatic_verification_guard ON automatic_reception_verifications;
 CREATE TRIGGER automatic_verification_guard BEFORE INSERT OR UPDATE OR DELETE ON automatic_reception_verifications FOR EACH ROW EXECUTE FUNCTION protect_automatic_verification();
 DROP TRIGGER IF EXISTS automatic_verification_truncate_guard ON automatic_reception_verifications;
 CREATE TRIGGER automatic_verification_truncate_guard BEFORE TRUNCATE ON automatic_reception_verifications FOR EACH STATEMENT EXECUTE FUNCTION protect_automatic_verification();
`;
/** Knowledge retrieval must not conceal a published FAQ conflict, unverified policy
 * context, source overflow or a foreign source. Call inside the lease transaction. */
export function automaticSemanticPolicyAllowed(input:Awaited<ReturnType<typeof loadAutomaticEvidence>>){
 if(!automaticSemanticQuestionAllowed(input.question)||input.sourceOverflow||input.policyOverflow||input.sources.length>20||
  input.sources.some(s=>s.tenantId!==input.tenantId)||!automaticPolicyDecision(input).allowed)return false;
 const probe=assessAutomaticEvidence({...input,reply:input.sources[0]?.answerText??'暂无匹配答复'});
 return ['approved_current_answer_required','unsupported_or_ambiguous_topic','knowledge_grounded_faq'].includes(probe.reason);
}
async function currentEvidence(c:Pick<PoolClient,'query'>,l:AutomaticReceptionLease,question:string,answer?:SemanticStructuredAnswer,
 phase:'generation'|'send'='generation',presentation:AutomaticPresentationOptions=automaticPresentationOptionsFromEnv()){
 const generation=(await c.query(`SELECT reason FROM automatic_reception_generations WHERE tenant_id=$1 AND job_id=$2
  AND worker_token=$3 AND state='succeeded'`,[l.tenantId,l.jobId,l.workerToken])).rows[0];
 if(!generation)return null;
 const styled=generation.reason==='semantic_styled_generated';
 if(styled||presentation.enabled?.()){
  if(!styled||!await currentStoredAutomaticPresentation(c,l,question,presentation,phase))return null;
 }
 if(!['semantic_generated','semantic_styled_generated'].includes(generation.reason))return null;
 const selected=await loadCurrentAutomaticSemanticContexts(c,l,question,phase);if(!selected)return null;
 const input=await loadAutomaticEvidence(c,l,question,{lock:true});
 if(input.evidenceRevision!==selected.sourceRevision||!automaticSemanticPolicyAllowed(input)||
  (answer&&!revalidateSemanticAnswer(answer,question,selected.contexts)))return null;
 return {selected,input,semanticProofs:selected.contexts.map(c=>c.proof)};
}
async function generationReceipt(c:Pick<PoolClient,'query'>,l:AutomaticReceptionLease,reply:string){
 return (await c.query(`SELECT 1 FROM automatic_reception_generations g JOIN ai_usage_calls b ON b.call_id=g.call_id
  AND b.tenant_id=g.tenant_id AND b.request_key=g.request_key WHERE g.tenant_id=$1 AND g.job_id=$2 AND g.worker_token=$3
   AND g.state='succeeded' AND g.reply_hash=$4 AND b.status='succeeded' AND b.feature='copilot' AND b.model=$5
   AND b.input_tokens::text=g.usage->>'input_tokens' AND b.output_tokens::text=g.usage->>'output_tokens'
   AND b.cached_input_tokens::text=g.usage->>'cached_input_tokens'`,[l.tenantId,l.jobId,l.workerToken,semanticHash(reply),initialAiPrices.text.model])).rowCount===1;
}
export function createMeteredAutomaticSemanticVerifier(db:Db,p:AutomaticGenerationPorts,presentation:AutomaticPresentationOptions=automaticPresentationOptionsFromEnv()){
 async function tx<T>(f:(c:PoolClient)=>Promise<T>){const c=await db.connect();try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms'");
  const v=await f(c);await c.query('COMMIT');return v;
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}}
 const finish=(l:AutomaticReceptionLease,state:'succeeded'|'failed'|'uncertain',reason:string,usage?:AiUsage,verdict?:SemanticVerdict)=>db.query(`
  UPDATE automatic_reception_verifications SET state=$4,reason=$5,usage=$6,verdict=$7,updated_at=clock_timestamp()
  WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3 AND state IN('prepared','reserved','requesting') RETURNING job_id`,
  [l.tenantId,l.jobId,l.workerToken,state,reason,usage??null,verdict??null]);
 return async(l:AutomaticReceptionLease,question:string,answer:SemanticStructuredAnswer):Promise<boolean>=>{
  if(!p.enabled()||!p.pointsEnabled()||!p.configured()||!automaticSemanticQuestionAllowed(question)||!answer?.text||automaticTextRisks(answer.text).length)return false;
  let prepared=false,callId:string|undefined,attempted=false,settlementStarted=false;
  const key=`automatic-verify:${l.jobId}`,maxTokens=1500;
  try{
   const evidence=await tx(c=>currentEvidence(c,l,question,answer,'generation',presentation));if(!evidence)return false;
   const messages=semanticVerificationMessages(question,answer,evidence.selected.contexts),serialized=JSON.stringify(messages);
   if(Buffer.byteLength(serialized)>40000)return false;
   prepared=await tx(async c=>{
    if(!p.enabled()||!p.pointsEnabled())return false;
    const fresh=await currentEvidence(c,l,question,answer,'generation',presentation);
    if(!fresh||fresh.selected.sourceRevision!==evidence.selected.sourceRevision||!await generationReceipt(c,l,answer.text))return false;
    return (await c.query(`INSERT INTO automatic_reception_verifications(job_id,tenant_id,worker_token,request_key,prompt_hash,
     question_hash,reply_hash,source_revision,claims,grounding_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT DO NOTHING RETURNING job_id`,[l.jobId,l.tenantId,l.workerToken,key,semanticHash(serialized),semanticHash(question),
      semanticHash(answer.text),fresh.selected.sourceRevision,JSON.stringify(answer.claims),SEMANTIC_GROUNDING_VERSION])).rowCount===1;
   });
   if(!prepared)return false;
   callId=await p.reserve(l.tenantId,key,Buffer.byteLength(serialized)+4096,maxTokens);
   if((await db.query(`UPDATE automatic_reception_verifications SET state='reserved',call_id=$4,updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3 AND state='prepared' RETURNING job_id`,[l.tenantId,l.jobId,l.workerToken,callId])).rowCount!==1)throw Error('verification_reservation_binding_failed');
   const barrier=await tx(async c=>{
    if(!p.enabled()||!p.pointsEnabled())return false;
    const fresh=await currentEvidence(c,l,question,answer,'generation',presentation);
    if(!fresh||fresh.selected.sourceRevision!==evidence.selected.sourceRevision||!await generationReceipt(c,l,answer.text))return false;
    if((await c.query(`SELECT 1 FROM ai_usage_calls WHERE tenant_id=$1 AND call_id=$2 AND request_key=$3 AND feature='copilot'
     AND model=$4 AND status='reserved' AND created_at>NOW()-INTERVAL '2 minutes' FOR SHARE`,[l.tenantId,callId,key,initialAiPrices.text.model])).rowCount!==1)return false;
    return (await c.query(`UPDATE automatic_reception_verifications SET state='requesting',attempted_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3 AND state='reserved' AND attempted_at IS NULL RETURNING job_id`,[l.tenantId,l.jobId,l.workerToken])).rowCount===1;
   });
   if(!barrier){settlementStarted=true;await p.settle(l.tenantId,callId,undefined,false,'automatic_verification_cancelled');await finish(l,'failed','authorization_or_source_changed');return false;}
   attempted=true;let output:Awaited<ReturnType<typeof p.model>>|undefined,usage:AiUsage|undefined,reason='provider_outcome_uncertain';
   try{output=await p.model(messages,maxTokens,true);usage=output.usage;}catch(error){
    const e=error as {code?:string;usage?:AiUsage};usage=e?.usage;
    if(['qwen_auth_failed','qwen_rate_limited','qwen_input_limit','qwen_not_configured','qwen_configuration_invalid'].includes(e?.code??''))reason='provider_rejected';
   }
   if(usage)priceAiUsage(usage,initialAiPrices.text);
   settlementStarted=true;await p.settle(l.tenantId,callId,usage,!!usage,usage?undefined:reason==='provider_rejected'?'automatic_verifier_rejected':'automatic_verifier_cost_unknown');
   const bill=(await db.query('SELECT status,input_tokens,output_tokens,cached_input_tokens FROM ai_usage_calls WHERE tenant_id=$1 AND call_id=$2',[l.tenantId,callId])).rows[0];
   if(!usage||bill?.status!=='succeeded'||Number(bill.input_tokens)!==usage.input_tokens||Number(bill.output_tokens)!==usage.output_tokens||Number(bill.cached_input_tokens)!==usage.cached_input_tokens){
    await finish(l,reason==='provider_rejected'?'failed':'uncertain',usage?'billing_receipt_unavailable':reason);return false;
   }
   const verdict=output?.model===initialAiPrices.text.model?parseSemanticVerdict(output.text,answer):null;
   if(!verdict){await finish(l,'failed','invalid_verdict_billed');return false;}
   const passed=await tx(async c=>{
    const fresh=p.enabled()&&p.pointsEnabled()?await currentEvidence(c,l,question,answer,'generation',presentation):null;
    return !!fresh&&fresh.selected.sourceRevision===evidence.selected.sourceRevision&&await generationReceipt(c,l,answer.text);
   });
   if(!passed){await finish(l,'failed','authorization_or_source_changed_after_verification');return false;}
   if((await finish(l,'succeeded',semanticVerdictPassed(verdict)?'verified':'semantic_review_required',usage,verdict)).rowCount!==1)return false;
   return semanticVerdictPassed(verdict);
  }catch(error){
   if(callId&&!settlementStarted)await p.settle(l.tenantId,callId,undefined,false,attempted?'automatic_verifier_cost_unknown':'automatic_verification_cancelled').catch(()=>{});
   if(prepared){const insufficient=!callId&&(error as {code?:string})?.code==='ai_points_insufficient';
    await finish(l,insufficient?'failed':'uncertain',insufficient?'points_insufficient':settlementStarted?'billing_outcome_uncertain':attempted?'provider_outcome_uncertain':'reservation_outcome_uncertain').catch(()=>{});}
   return false;
  }
 };
}
/** Final lease transaction: current documents, policies, disclosure, question,
 * generated answer and actual generation/verification receipts are bound again.
 * Semantic retrieval additionally requires its actual embedding receipt. Native pause,
 * latest-message, human-reply and channel-window checks remain separate gates. */
export async function assessVerifiedAutomaticSemanticEvidence(c:Pick<PoolClient,'query'>,l:AutomaticReceptionLease,question:string,reply:string,
 phase:'generation'|'send'='generation',presentation:AutomaticPresentationOptions=automaticPresentationOptionsFromEnv()):Promise<AutomaticEvidenceAssessment|null>{
 if(!automaticSemanticQuestionAllowed(question)||typeof reply!=='string'||!reply.trim()||reply.length>4000||automaticTextRisks(reply).length)return null;
 const row=(await c.query(`SELECT v.claims,v.verdict,v.source_revision FROM automatic_reception_verifications v
  JOIN ai_usage_calls b ON b.call_id=v.call_id AND b.tenant_id=v.tenant_id AND b.request_key=v.request_key
  WHERE v.tenant_id=$1 AND v.job_id=$2 AND v.worker_token=$3 AND v.question_hash=$4 AND v.reply_hash=$5
   AND v.grounding_version=$6 AND v.state='succeeded' AND v.reason='verified' AND b.status='succeeded'
   AND b.feature='copilot' AND b.model=$7 AND b.input_tokens::text=v.usage->>'input_tokens'
   AND b.output_tokens::text=v.usage->>'output_tokens' AND b.cached_input_tokens::text=v.usage->>'cached_input_tokens'`,
  [l.tenantId,l.jobId,l.workerToken,semanticHash(question),semanticHash(reply),SEMANTIC_GROUNDING_VERSION,initialAiPrices.text.model])).rows[0];
 if(!row||!await generationReceipt(c,l,reply))return null;
 const answer:SemanticStructuredAnswer={text:reply,claims:row.claims},fresh=await currentEvidence(c,l,question,answer,phase,presentation);
 if(!fresh||fresh.selected.sourceRevision!==row.source_revision)return null;
 const verdict=parseSemanticVerdict(JSON.stringify(row.verdict),answer);if(!verdict||!semanticVerdictPassed(verdict))return null;
 return {version:AUTOMATIC_SEMANTIC_EVIDENCE_VERSION,reason:'knowledge_grounded_semantic',requiresHumanApproval:false,evidenceCandidate:true,
  confidencePercent:95,risks:[],answerIds:[],documentIds:fresh.semanticProofs.map(p=>p.documentId),
  documentVersions:fresh.semanticProofs.map(p=>p.documentVersion),policyIds:automaticPolicyDecision(fresh.input).policyIds,
  replyHash:semanticHash(reply),evidenceRevision:fresh.selected.sourceRevision};
}
export async function recoverAutomaticSemanticVerifications(db:Pick<Pool,'query'>,before:Date,limit=100){
 if(!(before instanceof Date)||!Number.isFinite(before.getTime())||before.getTime()>Date.now()-300000||!Number.isInteger(limit)||limit<1||limit>100)throw Error('invalid_automatic_verification_recovery');
 return (await db.query(`WITH stale AS(SELECT job_id FROM automatic_reception_verifications WHERE state IN('prepared','reserved','requesting')
  AND updated_at<=$1 ORDER BY updated_at,job_id LIMIT $2 FOR UPDATE SKIP LOCKED)
  UPDATE automatic_reception_verifications v SET state='uncertain',reason='verification_interrupted_cost_unknown',updated_at=clock_timestamp()
  FROM stale WHERE v.job_id=stale.job_id RETURNING v.job_id`,[before,limit])).rows.map(r=>String(r.job_id));
}
