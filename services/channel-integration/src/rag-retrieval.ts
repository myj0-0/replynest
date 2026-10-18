import type { Pool } from 'pg';
import {documentScopeSql} from './knowledge-document-core.js';

export const RAG_CONTEXT_BYTES=32*1024;
// Top-K metadata selection happens before fetching any document body.
export const keywordEvidenceSql=`WITH candidates AS MATERIALIZED (
 SELECT d.document_id,k.score FROM knowledge_documents d
 CROSS JOIN LATERAL (SELECT count(*)::int score FROM unnest(d.keywords) kw
  WHERE kw<>'' AND strpos(lower($3),lower(kw))>0) k
 WHERE d.tenant_id=$1 AND d.status='active' AND k.score>0
 AND (d.valid_from IS NULL OR d.valid_from<=$2) AND (d.valid_until IS NULL OR d.valid_until>$2)
 ${documentScopeSql('d','$4::jsonb')}
 ORDER BY k.score DESC,d.document_id LIMIT 3)
SELECT d.document_id,left(d.title,200) title,left(d.source_type,80) source_type,d.version,
 c.chunk_id,left(COALESCE(c.content,d.content),1200) content,k.score
FROM candidates k JOIN knowledge_documents d ON d.document_id=k.document_id AND d.tenant_id=$1
LEFT JOIN LATERAL (
 SELECT c.chunk_id,c.content FROM knowledge_chunks c
 WHERE c.tenant_id=$1 AND c.document_id=d.document_id AND c.document_version=d.version
 ORDER BY (SELECT count(*) FROM unnest(d.keywords) kw
 WHERE kw<>'' AND strpos(lower($3),lower(kw))>0 AND strpos(lower(c.content),lower(kw))>0) DESC,
 c.chunk_index,c.chunk_id LIMIT 1
) c ON TRUE ORDER BY k.score DESC,d.document_id`;

export const historyEvidenceSql=`WITH candidates AS MATERIALIZED (
 SELECT e.example_id,k.score FROM historical_reply_examples e
 CROSS JOIN LATERAL (SELECT count(*)::int score FROM unnest(e.keywords) kw
 WHERE kw<>'' AND strpos(lower($2),lower(kw))>0) k
 WHERE e.tenant_id=$1 AND e.review_status='approved' AND e.pii_redacted=TRUE
 AND (e.policy_independent OR e.applicable_policy_ids && $3::uuid[]) AND k.score>0
 ORDER BY k.score DESC,e.example_id LIMIT 3)
SELECT e.example_id,left(e.source_conversation_id,200) source_conversation_id,
 left(e.customer_question,600) customer_question,left(e.agent_reply,1200) agent_reply,
 left(e.intent,120) intent,e.policy_independent,k.score
FROM candidates k JOIN historical_reply_examples e ON e.example_id=k.example_id AND e.tenant_id=$1
ORDER BY k.score DESC,e.example_id`;

export const semanticEvidenceSql=`SELECT c.chunk_id,d.document_id,left(d.title,200) title,
 left(d.source_type,80) source_type,d.version,left(c.content,1200) content,
 (1-(c.embedding <=> $3::vector))::float AS score
FROM knowledge_chunks c JOIN knowledge_documents d ON d.document_id=c.document_id AND d.tenant_id=c.tenant_id
WHERE c.tenant_id=$1 AND c.document_version=d.version AND c.embedding_status='ready'
 AND c.embedding_provider=$4 AND c.embedding_model=$5 AND d.status='active'
 AND (d.valid_from IS NULL OR d.valid_from<=$2) AND (d.valid_until IS NULL OR d.valid_until>$2)
 ${documentScopeSql('d','$6::jsonb')}
ORDER BY c.embedding <=> $3::vector LIMIT 3`;

export interface KnowledgeEvidence {
 document_id:string;title:string;source_type:string;version:number;content:string;
 chunk_id?:string;score:number;retrieval?:string;
}
export interface HistoryEvidence {
 example_id:string;source_conversation_id:string;customer_question:string;agent_reply:string;
 intent:string;policy_independent:boolean;score:number;
}
export async function boundedEvidenceQuery<T extends Record<string,unknown>>(db:Pool,sql:string,values:unknown[]) {
 const c=await db.connect();
 try {
  await c.query('BEGIN READ ONLY');
  await c.query("SET LOCAL statement_timeout='3000ms'");
  await c.query("SET LOCAL lock_timeout='500ms'");
  const result=await c.query<T>(sql,values);await c.query('COMMIT');return result;
 } catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
// Keyword counts and cosine similarity are incomparable; semantic hits take precedence.
// Budget includes metadata and JSON escaping, not just visible characters.
export function budgetEvidence(semantic:KnowledgeEvidence[],keyword:KnowledgeEvidence[],history:HistoryEvidence[]) {
 const result:{knowledge:KnowledgeEvidence[];history:HistoryEvidence[]}={knowledge:[],history:[]};
 const seen=new Set<string>();
 for(const [items,retrieval] of [[semantic,'semantic'],[keyword,'keyword']] as const)for(const item of items){
  if(result.knowledge.length===3||seen.has(item.document_id))continue;
  result.knowledge.push({...item,retrieval});
  if(Buffer.byteLength(JSON.stringify(result),'utf8')>RAG_CONTEXT_BYTES)result.knowledge.pop();
  else seen.add(item.document_id);
 }
 for(const item of history.slice(0,3)){
  result.history.push(item);
  if(Buffer.byteLength(JSON.stringify(result),'utf8')>RAG_CONTEXT_BYTES)result.history.pop();
 }
 return result;
}
