import type {PoolClient} from 'pg';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import type {ReceptionDraft} from './reception-executor.js';
import {automaticRevisionSchema,automaticEvidenceRevision} from './automatic-reception-revision.js';
import {AUTOMATIC_EVIDENCE_VERSION,assessAutomaticEvidence,compactAutomaticText,
 type AutomaticAnswerEvidence,type AutomaticPolicyEvidence} from './automatic-reception-evidence.js';
import {publishedKnowledgeFaqAnswers} from './automatic-knowledge-faq.js';
import {automaticKnowledgeAuthorized} from './automatic-knowledge-consent.js';
import {documentScopeSql,documentControlsEnabled} from './knowledge-document-core.js';
import {currentAutomaticGenerationLease} from './automatic-reception-generation-lease.js';
import {automaticPresentationOptionsFromEnv,currentStoredAutomaticPresentation} from './reception-automatic-presentation.js';
type Db=Pick<PoolClient,'query'>;
/** Legacy exact-answer tables are retained for immutable audit and compatibility.
 * Current delivery uses published knowledge retrieval plus independent verification.
 */
export const automaticEvidenceSchema=`
 CREATE TABLE IF NOT EXISTS automatic_reception_answers(
  answer_id UUID PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  document_id UUID NOT NULL REFERENCES knowledge_documents(document_id),document_version INTEGER NOT NULL CHECK(document_version>0),
  topic TEXT NOT NULL CHECK(topic IN('opening_hours','shipping_information','contact_information','usage_instructions')),
  answer_text TEXT NOT NULL CHECK(length(answer_text) BETWEEN 1 AND 4000),keywords TEXT[] NOT NULL CHECK(cardinality(keywords) BETWEEN 1 AND 12),
  question_texts TEXT[] NOT NULL CHECK(cardinality(question_texts) BETWEEN 1 AND 20),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','approved','disabled')),
  approval_version TEXT,approved_by TEXT,requires_human_approval BOOLEAN NOT NULL DEFAULT true,
  valid_from TIMESTAMPTZ NOT NULL,valid_until TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(valid_until>valid_from),
  CHECK(status<>'approved' OR (approval_version='${AUTOMATIC_EVIDENCE_VERSION}' AND approved_by IS NOT NULL AND length(approved_by)>0) IS TRUE)
 );
 CREATE INDEX IF NOT EXISTS automatic_answers_lookup ON automatic_reception_answers(tenant_id,topic,document_id,answer_id) WHERE status='approved';
 CREATE OR REPLACE FUNCTION protect_automatic_answer_approval() RETURNS trigger AS $$
 BEGIN
  IF ROW(NEW.answer_id,NEW.tenant_id) IS DISTINCT FROM ROW(OLD.answer_id,OLD.tenant_id) THEN RAISE EXCEPTION 'automatic answer owner is immutable'; END IF;
  IF ROW(NEW.document_id,NEW.document_version,NEW.topic,NEW.answer_text,NEW.keywords,NEW.question_texts,NEW.valid_from,NEW.valid_until)
   IS DISTINCT FROM ROW(OLD.document_id,OLD.document_version,OLD.topic,OLD.answer_text,OLD.keywords,OLD.question_texts,OLD.valid_from,OLD.valid_until)
   AND NOT(NEW.status='draft' AND NEW.approval_version IS NULL AND NEW.approved_by IS NULL)
   THEN RAISE EXCEPTION 'changed automatic answer needs fresh approval'; END IF;
  IF NEW.requires_human_approval IS DISTINCT FROM OLD.requires_human_approval
   AND NOT((NEW.status='draft' AND NEW.approval_version IS NULL AND NEW.approved_by IS NULL)
    OR (NEW.status='disabled' AND NEW.requires_human_approval AND NEW.approval_version IS NULL AND NEW.approved_by IS NULL)
    OR (OLD.status='draft' AND NEW.status='approved' AND NOT NEW.requires_human_approval
     AND NEW.approval_version='${AUTOMATIC_EVIDENCE_VERSION}' AND NEW.approved_by IS NOT NULL AND length(NEW.approved_by)>0))
   THEN RAISE EXCEPTION 'changed automatic answer needs fresh approval'; END IF;
  RETURN NEW;
 END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS automatic_answer_approval_guard ON automatic_reception_answers;
 CREATE TRIGGER automatic_answer_approval_guard BEFORE UPDATE ON automatic_reception_answers FOR EACH ROW EXECUTE FUNCTION protect_automatic_answer_approval();
 CREATE TABLE IF NOT EXISTS automatic_reception_assessments(
  assessment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  job_id UUID NOT NULL REFERENCES automatic_reception_jobs(job_id),phase TEXT NOT NULL CHECK(phase IN('post_generation','before_submit')),
  assessment JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 CREATE INDEX IF NOT EXISTS automatic_assessments_tenant_job ON automatic_reception_assessments(tenant_id,job_id,created_at,assessment_id);
 CREATE OR REPLACE FUNCTION protect_automatic_assessment() RETURNS trigger AS $$
 BEGIN RAISE EXCEPTION 'automatic assessment is append only'; END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS automatic_assessment_guard ON automatic_reception_assessments;
 CREATE TRIGGER automatic_assessment_guard BEFORE UPDATE OR DELETE ON automatic_reception_assessments FOR EACH ROW EXECUTE FUNCTION protect_automatic_assessment();
 ${automaticRevisionSchema}
`;
/** Bounded published FAQ conflict probes and 101 policy rows; no legacy answer reads.
 * When lock=true caller MUST own a READ COMMITTED transaction, holding the tenant revision
 * shared lock until the submit barrier commits. All evidence writes take the same guard.
 */
export async function loadAutomaticEvidence(db:Db,l:AutomaticReceptionLease,question:string,
 options:{lock?:boolean;now?:Date}={}){
 // Grant -> source revision is the same lock order as generation and management.
 // Missing or old disclosure never reads FAQ bodies, even if the release flag is on.
 const knowledgeAuthorized=process.env.AI_RECEPTION_KNOWLEDGE_ANSWERS_ENABLED==='true'&&
  await automaticKnowledgeAuthorized(db,l,options.lock===true);
 const evidenceRevision=await automaticEvidenceRevision(db,l.tenantId,options.lock===true);
 const now=options.now??new Date(),normalized=compactAutomaticText(typeof question==='string'?question:'');
 // Keyword/topic matching is in the pure policy; do not let a model select the answer IDs.
 const policies=await db.query(`SELECT tenant_id "tenantId",policy_id "policyId",priority,scope,conditions,decision,
  requires_human_approval "requiresHumanApproval",forbidden_actions "forbiddenActions",eligibility_time_basis "timeBasis"
 FROM temporary_policies WHERE tenant_id=$1 AND status='active' AND valid_from<=$2 AND valid_until>$2
 ORDER BY priority DESC,policy_id LIMIT 101`, [l.tenantId,now]);
 const knowledge:AutomaticAnswerEvidence[]=[];let knowledgeOverflow=false;
 // Explicit release gate. Existing exact-FAQ grants do NOT silently read the entire KB.
 // No embedding/history/profile reads; bounded keyword retrieval of published FAQ documents.
 if(knowledgeAuthorized){
  const docs=await db.query(`WITH candidates AS MATERIALIZED (
   SELECT document_id FROM knowledge_documents d WHERE tenant_id=$1 AND status='active'
    AND ingestion_status='ready' AND parse_status IN('ready','parsed') AND scan_status IN('clean','not_required')
    AND (valid_from IS NULL OR valid_from<=$2) AND (valid_until IS NULL OR valid_until>$2)
    ${documentScopeSql('d','$4::jsonb',true)}
    AND EXISTS(SELECT 1 FROM unnest(keywords) kw WHERE length(kw) BETWEEN 2 AND 40 AND strpos($3,lower(kw))>0)
   ORDER BY document_id LIMIT 4)
   SELECT d.tenant_id "tenantId",d.document_id "documentId",d.version,left(d.content,12001) content,
    COALESCE(d.valid_from,'1970-01-01'::timestamptz) "validFrom",COALESCE(d.valid_until,'9999-01-01'::timestamptz) "validUntil"
   FROM candidates c JOIN knowledge_documents d ON d.document_id=c.document_id AND d.tenant_id=$1 ORDER BY d.document_id`,[l.tenantId,now,normalized,...(documentControlsEnabled()?[JSON.stringify({channel:l.channel})]:[])]);
  knowledgeOverflow=docs.rows.length>3;
  for(const d of docs.rows.slice(0,3))knowledge.push(...publishedKnowledgeFaqAnswers({...d,validFrom:new Date(d.validFrom).toISOString(),validUntil:new Date(d.validUntil).toISOString()},question));
 }
 return {tenantId:l.tenantId,channel:l.channel,question,now,evidenceRevision,
  sources:knowledge,
  policies:policies.rows as AutomaticPolicyEvidence[],sourceOverflow:knowledge.length>20||knowledgeOverflow,policyOverflow:policies.rows.length>100};
}
export async function assessStoredAutomaticEvidence(db:Db,l:AutomaticReceptionLease,d:ReceptionDraft,question:string,
 options:{lock?:boolean;now?:Date;phase?:'generation'|'send'}={}){
 // Semantic authorization reads must lock job/grant before source revision.
 // An unlocked diagnostic is never allowed to certify the new send path.
 const presentation=automaticPresentationOptionsFromEnv(),presentationEnabled=!!presentation.enabled?.();
 const semanticLease=process.env.AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED==='true'&&options.lock===true&&
  await currentAutomaticGenerationLease(db,l,question,options.phase);
 // Take personalization before the source revision lock, as generation does.
 const presentationCurrent=presentationEnabled&&semanticLease&&await currentStoredAutomaticPresentation(db,l,question,presentation,options.phase);
 const input=await loadAutomaticEvidence(db,l,question,options);
 const result=assessAutomaticEvidence({...input,reply:d.text});
 const generation=(await db.query(`SELECT reason FROM automatic_reception_generations WHERE tenant_id=$1 AND job_id=$2
  AND worker_token=$3 AND state='succeeded'`,[l.tenantId,l.jobId,l.workerToken])).rows[0];
 const styled=generation?.reason==='semantic_styled_generated';
 if(presentationEnabled||styled){
  // Even a verbatim result cannot bypass revoked presentation or verification.
  if(!styled||!presentationCurrent)return {...result,reason:'presentation_changed_or_unverified',evidenceCandidate:false,
   requiresHumanApproval:true,confidencePercent:0,evidenceRevision:input.evidenceRevision};
 }
 if(semanticLease){
  // Default-off component: no access to staged tables under an old release.
  const {assessVerifiedAutomaticSemanticEvidence}=await import('./automatic-knowledge-verification.js');
  const verified=await assessVerifiedAutomaticSemanticEvidence(db,l,question,d.text,options.phase);
  if(verified)return verified;
 }
 return {...result,reason:'knowledge_verification_required',evidenceCandidate:false,requiresHumanApproval:true,
  confidencePercent:0,evidenceRevision:input.evidenceRevision};
}
export async function recordAutomaticAssessment(db:Db,l:AutomaticReceptionLease,phase:'post_generation'|'before_submit',assessment:ReturnType<typeof assessAutomaticEvidence>){
 const r=await db.query(`INSERT INTO automatic_reception_assessments(tenant_id,job_id,phase,assessment)
 SELECT tenant_id,job_id,$5,$6 FROM automatic_reception_jobs WHERE tenant_id=$1 AND job_id=$2 AND message_id=$3 AND worker_token=$4 AND state='processing'
 RETURNING assessment_id`,[l.tenantId,l.jobId,l.messageId,l.workerToken,phase,assessment]);
 if(!r.rowCount)throw Error('automatic_assessment_lease_lost');
}
