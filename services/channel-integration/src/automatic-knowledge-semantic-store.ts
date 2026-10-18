import type {Pool,PoolClient} from 'pg';
import {documentScopeSql,documentControlsEnabled} from './knowledge-document-core.js';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import {currentAutomaticGenerationLease} from './automatic-reception-generation-lease.js';
import {automaticSemanticKnowledgeAuthorized} from './automatic-knowledge-consent.js';
import {automaticEvidenceRevision} from './automatic-reception-revision.js';
import {automaticSemanticQuestionAllowed} from './automatic-knowledge-grounding.js';
import {initialAiPrices,priceAiUsage,type AiUsage} from './ai-points-core.js';
import {semanticHash,validateSemanticVector,selectSemanticKnowledgeContexts,revalidateSemanticContext,
 SEMANTIC_MIN_SIMILARITY,type SemanticKnowledgeHit,type SemanticKnowledgeProof,type SemanticKnowledgeContext} from './automatic-knowledge-semantic.js';

type Db=Pick<Pool,'query'|'connect'>;
/** Separate opt-in owner migration. NOT installed by current production startup.
 * Embeddings mutate evidence too: protect them with the tenant revision guard.
 * Lock order remains grant -> tenant revision -> journal; never source-row locks.
 */
export const automaticSemanticKnowledgeSchema=`
 DROP TRIGGER IF EXISTS automatic_evidence_write_guard ON knowledge_chunks;
 CREATE TRIGGER automatic_evidence_write_guard BEFORE INSERT OR UPDATE OR DELETE ON knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION guard_automatic_evidence_write();
 DROP TRIGGER IF EXISTS automatic_evidence_truncate_guard ON knowledge_chunks;
 CREATE TRIGGER automatic_evidence_truncate_guard BEFORE TRUNCATE ON knowledge_chunks
  FOR EACH STATEMENT EXECUTE FUNCTION guard_automatic_evidence_write();
 CREATE TABLE IF NOT EXISTS automatic_reception_retrievals(
  job_id UUID PRIMARY KEY REFERENCES automatic_reception_jobs(job_id),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  worker_token UUID NOT NULL,request_key TEXT NOT NULL UNIQUE,question_hash TEXT NOT NULL CHECK(question_hash ~ '^[a-f0-9]{64}$'),
  call_id UUID UNIQUE REFERENCES ai_usage_calls(call_id),state TEXT NOT NULL DEFAULT 'prepared'
   CHECK(state IN('prepared','reserved','requesting','succeeded','failed','uncertain')),
  attempted_at TIMESTAMPTZ,vector_hash TEXT CHECK(vector_hash ~ '^[a-f0-9]{64}$'),usage JSONB,
  selected_proofs JSONB,source_revision TEXT CHECK(source_revision ~ '^[0-9]{1,19}$'),reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(state NOT IN('reserved','requesting','succeeded') OR call_id IS NOT NULL),
  CHECK(state NOT IN('requesting','succeeded') OR attempted_at IS NOT NULL),
  CHECK(state<>'succeeded' OR (vector_hash IS NOT NULL AND usage IS NOT NULL AND selected_proofs IS NOT NULL AND source_revision IS NOT NULL)),
  CHECK(selected_proofs IS NULL OR (jsonb_typeof(selected_proofs)='array' AND jsonb_array_length(selected_proofs)<=6 AND octet_length(selected_proofs::text)<=8192))
 );
 CREATE INDEX IF NOT EXISTS automatic_retrieval_stale ON automatic_reception_retrievals(updated_at,job_id) WHERE state IN('prepared','reserved','requesting');
 CREATE INDEX IF NOT EXISTS automatic_retrieval_tenant_page ON automatic_reception_retrievals(tenant_id,created_at DESC,job_id);
 CREATE OR REPLACE FUNCTION protect_automatic_retrieval() RETURNS trigger AS $$
 BEGIN
  IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'automatic retrieval history is immutable'; END IF;
  IF TG_OP='INSERT' THEN
   IF NEW.state<>'prepared' OR NEW.call_id IS NOT NULL OR NEW.attempted_at IS NOT NULL OR NEW.selected_proofs IS NOT NULL OR
    NEW.vector_hash IS NOT NULL OR NEW.usage IS NOT NULL OR NEW.source_revision IS NOT NULL OR
    NEW.request_key<>'automatic-knowledge-query:'||NEW.job_id::text OR NOT EXISTS(SELECT 1 FROM automatic_reception_jobs j
     WHERE j.job_id=NEW.job_id AND j.tenant_id=NEW.tenant_id AND j.worker_token=NEW.worker_token AND j.state='processing')
    THEN RAISE EXCEPTION 'invalid automatic retrieval owner'; END IF;
  ELSE
   IF OLD.state IN('succeeded','failed','uncertain') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'automatic retrieval outcome is immutable'; END IF;
   IF ROW(NEW.job_id,NEW.tenant_id,NEW.worker_token,NEW.request_key,NEW.question_hash,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.job_id,OLD.tenant_id,OLD.worker_token,OLD.request_key,OLD.question_hash,OLD.created_at)
    THEN RAISE EXCEPTION 'automatic retrieval identity is immutable'; END IF;
   IF OLD.call_id IS NOT NULL AND NEW.call_id IS DISTINCT FROM OLD.call_id THEN RAISE EXCEPTION 'automatic retrieval billing identity is immutable'; END IF;
   IF NEW.call_id IS DISTINCT FROM OLD.call_id AND NOT(OLD.state='prepared' AND NEW.state='reserved')
    THEN RAISE EXCEPTION 'invalid automatic retrieval billing transition'; END IF;
   IF OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at THEN RAISE EXCEPTION 'automatic retrieval attempt is immutable'; END IF;
   IF OLD.attempted_at IS NULL AND NEW.attempted_at IS NOT NULL AND NOT(OLD.state='reserved' AND NEW.state='requesting')
    THEN RAISE EXCEPTION 'retrieval attempt requires reservation barrier'; END IF;
   IF NOT(OLD.state=NEW.state OR (OLD.state='prepared' AND NEW.state IN('reserved','failed','uncertain')) OR
    (OLD.state='reserved' AND NEW.state IN('requesting','failed','uncertain')) OR (OLD.state='requesting' AND NEW.state IN('succeeded','failed','uncertain')))
    THEN RAISE EXCEPTION 'invalid automatic retrieval transition'; END IF;
   IF ROW(NEW.vector_hash,NEW.usage,NEW.selected_proofs,NEW.source_revision) IS DISTINCT FROM ROW(OLD.vector_hash,OLD.usage,OLD.selected_proofs,OLD.source_revision)
    AND NOT(OLD.state='requesting' AND NEW.state='succeeded') THEN RAISE EXCEPTION 'retrieval result requires completed attempt'; END IF;
  END IF;
  IF NEW.call_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ai_usage_calls c WHERE c.call_id=NEW.call_id AND c.tenant_id=NEW.tenant_id
   AND c.request_key=NEW.request_key AND c.feature='embedding_query' AND c.model='${initialAiPrices.embedding.model}')
   THEN RAISE EXCEPTION 'invalid automatic retrieval billing owner'; END IF;
  IF NEW.state='succeeded' AND NOT EXISTS(SELECT 1 FROM ai_usage_calls c WHERE c.call_id=NEW.call_id AND c.tenant_id=NEW.tenant_id
   AND c.status='succeeded' AND c.input_tokens::text=NEW.usage->>'input_tokens'
   AND c.output_tokens=0 AND c.cached_input_tokens::text=NEW.usage->>'cached_input_tokens'
   AND NEW.usage->>'output_tokens'='0') THEN RAISE EXCEPTION 'automatic retrieval billing receipt required'; END IF;
  RETURN NEW;
 END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS automatic_retrieval_guard ON automatic_reception_retrievals;
 CREATE TRIGGER automatic_retrieval_guard BEFORE INSERT OR UPDATE OR DELETE ON automatic_reception_retrievals FOR EACH ROW EXECUTE FUNCTION protect_automatic_retrieval();
 DROP TRIGGER IF EXISTS automatic_retrieval_truncate_guard ON automatic_reception_retrievals;
 CREATE TRIGGER automatic_retrieval_truncate_guard BEFORE TRUNCATE ON automatic_reception_retrievals FOR EACH STATEMENT EXECUTE FUNCTION protect_automatic_retrieval();
`;
// Select IDs first, then bounded bodies. The 7th hit is a review sentinel, NOT
// a silently discarded conflicting source. Tenant predicates are on BOTH tables.
export const automaticSemanticKnowledgeSql=`WITH candidates AS MATERIALIZED (
 SELECT c.chunk_id,(1-(c.embedding <=> $3::vector))::float similarity
 FROM knowledge_chunks c JOIN knowledge_documents d ON d.document_id=c.document_id AND d.tenant_id=c.tenant_id
 WHERE c.tenant_id=$1 AND d.tenant_id=$1 AND c.document_version=d.version AND c.embedding_status='ready'
  AND c.embedding_provider='qwen' AND c.embedding_model=$4 AND c.embedding IS NOT NULL
  AND d.status='active' AND d.ingestion_status='ready' AND d.parse_status IN('ready','parsed') AND d.scan_status IN('clean','not_required')
  AND (d.valid_from IS NULL OR d.valid_from<=$2) AND (d.valid_until IS NULL OR d.valid_until>$2)
  ${documentScopeSql('d','$6::jsonb',true)}
  AND (1-(c.embedding <=> $3::vector)) >= $5
 ORDER BY c.embedding <=> $3::vector,c.chunk_id LIMIT 7)
 SELECT c.tenant_id "tenantId",c.document_id "documentId",c.document_version "documentVersion",d.version "currentDocumentVersion",
  c.chunk_id "chunkId",c.chunk_index "chunkIndex",left(c.content,2001) "chunkText",left(d.content,120001) content,k.similarity
 FROM candidates k JOIN knowledge_chunks c ON c.chunk_id=k.chunk_id AND c.tenant_id=$1
 JOIN knowledge_documents d ON d.document_id=c.document_id AND d.tenant_id=$1 ORDER BY k.similarity DESC,c.chunk_id`;
export type AutomaticSemanticRetrievalPorts={
 enabled():boolean;pointsEnabled():boolean;configured():boolean;
 reserve(tenant:string,key:string,inputBound:number):Promise<string>;
 settle(tenant:string,callId:string,usage:AiUsage|undefined,succeeded:boolean,errorCode?:string):Promise<void>;
 embed(question:string):Promise<{vector:number[];model:string;usage:AiUsage}>;
};
export type AutomaticSemanticRetrieval={contexts:SemanticKnowledgeContext[];sourceRevision:string};
/** Staged retrieval service. Not composed into a sender yet. Its result proves
 * provenance only: semantic similarity and model-selected citations never count
 * as automatic send approval. Missing receipt/uncertain outcome is not retried. */
export function createMeteredAutomaticSemanticRetriever(db:Db,p:AutomaticSemanticRetrievalPorts){
 async function tx<T>(f:(c:PoolClient)=>Promise<T>){const c=await db.connect();try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms'");
  const result=await f(c);await c.query('COMMIT');return result;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
 const authorized=async(c:PoolClient,l:AutomaticReceptionLease,q:string)=>p.enabled()&&p.pointsEnabled()&&
  await currentAutomaticGenerationLease(c,l,q)&&await automaticSemanticKnowledgeAuthorized(c,l,true);
 const finish=async(l:AutomaticReceptionLease,state:'failed'|'uncertain',reason:string)=>db.query(`UPDATE automatic_reception_retrievals
  SET state=$4,reason=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3
   AND state IN('prepared','reserved','requesting')`,[l.tenantId,l.jobId,l.workerToken,state,reason]);
 return async(l:AutomaticReceptionLease,question:string):Promise<AutomaticSemanticRetrieval|null>=>{
  if(!p.enabled()||!p.pointsEnabled()||!p.configured()||typeof question!=='string'||!question.trim()||question.length>4000||
   !automaticSemanticQuestionAllowed(question))return null;
  let prepared=false,callId:string|undefined,attempted=false,settlementStarted=false;
  const key=`automatic-knowledge-query:${l.jobId}`;
  try{
   prepared=await tx(async c=>{
    if(!await authorized(c,l,question))return false;
    return (await c.query(`INSERT INTO automatic_reception_retrievals(job_id,tenant_id,worker_token,request_key,question_hash)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING job_id`,[l.jobId,l.tenantId,l.workerToken,key,semanticHash(question)])).rowCount===1;
   });
   if(!prepared)return null;
   callId=await p.reserve(l.tenantId,key,Buffer.byteLength(question)+4096);
   const bound=await db.query(`UPDATE automatic_reception_retrievals SET state='reserved',call_id=$4,updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3 AND state='prepared' RETURNING job_id`,[l.tenantId,l.jobId,l.workerToken,callId]);
   if(bound.rowCount!==1)throw Error('retrieval_reservation_binding_failed');
   const barrier=await tx(async c=>{
    if(!await authorized(c,l,question))return false;
    const bill=await c.query(`SELECT 1 FROM ai_usage_calls WHERE tenant_id=$1 AND call_id=$2 AND request_key=$3 AND feature='embedding_query'
     AND model=$4 AND status='reserved' AND created_at>NOW()-INTERVAL '2 minutes' FOR SHARE`,[l.tenantId,callId,key,initialAiPrices.embedding.model]);
    if(bill.rowCount!==1)return false;
    return (await c.query(`UPDATE automatic_reception_retrievals SET state='requesting',attempted_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3 AND state='reserved' AND attempted_at IS NULL RETURNING job_id`,[l.tenantId,l.jobId,l.workerToken])).rowCount===1;
   });
   if(!barrier){settlementStarted=true;await p.settle(l.tenantId,callId,undefined,false,'automatic_retrieval_cancelled');await finish(l,'failed','authorization_or_reservation_changed');return null;}
   attempted=true;let output:Awaited<ReturnType<typeof p.embed>>|undefined,usage:AiUsage|undefined,reason='provider_outcome_uncertain';
   try{output=await p.embed(question);usage=output.usage;}catch(error){
    const e=error as {code?:string;usage?:AiUsage};usage=e?.usage;
    if(['qwen_auth_failed','qwen_rate_limited','qwen_input_limit','qwen_not_configured','qwen_configuration_invalid'].includes(e?.code??''))reason='provider_rejected';
   }
   if(usage){priceAiUsage(usage,initialAiPrices.embedding);if(usage.output_tokens!==0)throw Error('invalid_embedding_usage');}
   settlementStarted=true;await p.settle(l.tenantId,callId,usage,!!usage,usage?undefined:reason==='provider_rejected'?'automatic_embedding_rejected':'automatic_embedding_cost_unknown');
   const bill=(await db.query('SELECT status,input_tokens,output_tokens,cached_input_tokens FROM ai_usage_calls WHERE tenant_id=$1 AND call_id=$2',[l.tenantId,callId])).rows[0];
   if(!usage||bill?.status!=='succeeded'||Number(bill.input_tokens)!==usage.input_tokens||Number(bill.output_tokens)!==0||Number(bill.cached_input_tokens)!==usage.cached_input_tokens){
    await finish(l,reason==='provider_rejected'?'failed':'uncertain',usage?'billing_receipt_unavailable':reason);return null;
   }
   if(!output||output.model!==initialAiPrices.embedding.model||!validateSemanticVector(output.vector)){
    await finish(l,'failed','invalid_vector_billed');return null;
   }
   return await tx(async c=>{
    if(!await authorized(c,l,question)){await finishInTransaction(c,l,'authorization_changed_after_embedding');return null;}
    const sourceRevision=await automaticEvidenceRevision(c,l.tenantId,true);
    const hits=await c.query(automaticSemanticKnowledgeSql,[l.tenantId,new Date(),JSON.stringify(output.vector),initialAiPrices.embedding.model,SEMANTIC_MIN_SIMILARITY,...(documentControlsEnabled()?[JSON.stringify({channel:l.channel})]:[])]);
    const contexts=selectSemanticKnowledgeContexts(hits.rows as SemanticKnowledgeHit[],l.tenantId);
    const saved=await c.query(`UPDATE automatic_reception_retrievals SET state='succeeded',vector_hash=$4,usage=$5,selected_proofs=$6,
     source_revision=$7,reason=$8,updated_at=clock_timestamp() WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3
      AND state='requesting' RETURNING job_id`,[l.tenantId,l.jobId,l.workerToken,semanticHash(JSON.stringify(output.vector)),usage,
      JSON.stringify((contexts??[]).map(c=>c.proof)),sourceRevision,contexts===null?'source_provenance_review_required':contexts.length?'sources_selected':'no_current_source']);
    return saved.rowCount===1&&contexts!==null?{contexts,sourceRevision}:null;
   });
  }catch(error){
   if(callId&&!settlementStarted)await p.settle(l.tenantId,callId,undefined,false,attempted?'automatic_embedding_cost_unknown':'automatic_retrieval_cancelled').catch(()=>{});
   if(prepared){const insufficient=!callId&&(error as {code?:string})?.code==='ai_points_insufficient';
    await finish(l,insufficient?'failed':'uncertain',insufficient?'points_insufficient':settlementStarted?'billing_or_retrieval_outcome_uncertain':attempted?'provider_outcome_uncertain':'reservation_outcome_uncertain').catch(()=>{});}
   return null;
  }
 };
}
async function finishInTransaction(c:PoolClient,l:AutomaticReceptionLease,reason:string){
 await c.query(`UPDATE automatic_reception_retrievals SET state='failed',reason=$4,updated_at=clock_timestamp()
  WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3 AND state='requesting'`,[l.tenantId,l.jobId,l.workerToken,reason]);
}
/** Uses the persisted server selection, not IDs supplied by a model or browser.
 * Caller owns READ COMMITTED txn; holds grant/revision until its next barrier.
 * Returning contexts does not waive final relevance, policy or native send gates. */
export async function loadCurrentAutomaticSemanticContexts(c:Pick<PoolClient,'query'>,l:AutomaticReceptionLease,question:string,
 phase:'generation'|'send'='generation'):Promise<AutomaticSemanticRetrieval|null>{
 if(!automaticSemanticQuestionAllowed(question))return null;
 if(!await currentAutomaticGenerationLease(c,l,question,phase)||!await automaticSemanticKnowledgeAuthorized(c,l,true))return null;
 const sourceRevision=await automaticEvidenceRevision(c,l.tenantId,true);
 const row=(await c.query(`SELECT r.selected_proofs,r.source_revision FROM automatic_reception_retrievals r
  JOIN ai_usage_calls b ON b.call_id=r.call_id AND b.tenant_id=r.tenant_id AND b.request_key=r.request_key
  WHERE r.tenant_id=$1 AND r.job_id=$2 AND r.worker_token=$3 AND r.question_hash=$4 AND r.state='succeeded'
   AND r.reason='sources_selected' AND b.status='succeeded' AND b.feature='embedding_query' AND b.model=$5`,
  [l.tenantId,l.jobId,l.workerToken,semanticHash(question),initialAiPrices.embedding.model])).rows[0];
 if(!row||row.source_revision!==sourceRevision||!Array.isArray(row.selected_proofs)||!row.selected_proofs.length||row.selected_proofs.length>6)return null;
 const proofs=row.selected_proofs as SemanticKnowledgeProof[];
 const rows=await c.query(`SELECT c.tenant_id "tenantId",c.document_id "documentId",c.document_version "documentVersion",d.version "currentDocumentVersion",
  c.chunk_id "chunkId",c.chunk_index "chunkIndex",left(c.content,2001) "chunkText",left(d.content,120001) content
  FROM knowledge_chunks c JOIN knowledge_documents d ON d.document_id=c.document_id AND d.tenant_id=c.tenant_id
  WHERE c.tenant_id=$1 AND d.tenant_id=$1 AND c.chunk_id=ANY($2::uuid[]) AND c.document_version=d.version
   AND c.embedding_status='ready' AND c.embedding_provider='qwen' AND c.embedding_model=$3 AND c.embedding IS NOT NULL
   AND d.status='active' AND d.ingestion_status='ready' AND d.parse_status IN('ready','parsed') AND d.scan_status IN('clean','not_required')
   AND (d.valid_from IS NULL OR d.valid_from<=NOW()) AND (d.valid_until IS NULL OR d.valid_until>NOW())
   ${documentScopeSql('d','$4::jsonb',true)}`,[l.tenantId,proofs.map(p=>p.chunkId),initialAiPrices.embedding.model,...(documentControlsEnabled()?[JSON.stringify({channel:l.channel})]:[])]);
 const contexts:SemanticKnowledgeContext[]=[];
 for(const proof of proofs){const hit=rows.rows.find(r=>r.chunkId===proof.chunkId);
  if(!hit)return null;
  // Similarity is not re-created or promoted to a readiness/confidence score.
  const current=revalidateSemanticContext(proof,{...hit,similarity:SEMANTIC_MIN_SIMILARITY},l.tenantId);if(!current)return null;contexts.push(current);
 }
 if(selectSemanticKnowledgeContexts(rows.rows.map(r=>({...r,similarity:SEMANTIC_MIN_SIMILARITY})),l.tenantId)===null)return null;
 return {contexts,sourceRevision};
}
export async function recoverAutomaticSemanticRetrievals(db:Pick<Pool,'query'>,before:Date,limit=100){
 if(!(before instanceof Date)||!Number.isFinite(before.getTime())||before.getTime()>Date.now()-300000||!Number.isInteger(limit)||limit<1||limit>100)throw Error('invalid_automatic_retrieval_recovery');
 const r=await db.query(`WITH stale AS(SELECT job_id FROM automatic_reception_retrievals WHERE state IN('prepared','reserved','requesting')
  AND updated_at<=$1 ORDER BY updated_at,job_id LIMIT $2 FOR UPDATE SKIP LOCKED)
  UPDATE automatic_reception_retrievals r SET state='uncertain',reason='retrieval_interrupted_cost_unknown',updated_at=clock_timestamp()
  FROM stale WHERE r.job_id=stale.job_id RETURNING r.job_id`,[before,limit]);
 return r.rows.map(row=>String(row.job_id));
}
