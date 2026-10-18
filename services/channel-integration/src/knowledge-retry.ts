import type {PoolClient} from 'pg';
import {enqueueKnowledgeJob} from './knowledge-jobs.js';

export class KnowledgeProcessingBusy extends Error {}

// Caller owns a transaction. The document lock serializes all manual retries;
// drafts from the template market cannot use this path to skip review/approval.
export async function queueKnowledgeReprocessing(client:PoolClient,tenant:string,documentId:string){
 const document=(await client.query<{status:string;scan_status:string;parse_status:string;storage_key:string|null;content_format:string}>(
  `SELECT status,scan_status,parse_status,storage_key,content_format FROM knowledge_documents
   WHERE tenant_id=$1 AND document_id=$2 FOR UPDATE`,[tenant,documentId])).rows[0];
 const uploadDraft=document?.status==='draft'&&document.scan_status==='clean'&&document.parse_status==='parsed'
  &&!!document.storage_key&&['text','markdown','pdf','docx'].includes(document.content_format);
 if(!document||(document.status!=='active'&&!uploadDraft))return undefined;
 const pending=await client.query(`SELECT 1 FROM knowledge_jobs WHERE tenant_id=$1 AND document_id=$2
  AND (status IN ('queued','running') OR (status='failed' AND attempts<max_attempts)) LIMIT 1`,[tenant,documentId]);
 if(pending.rowCount)throw new KnowledgeProcessingBusy('knowledge_processing_busy');
 if(uploadDraft){
  // Retain ready vectors: retries of an identical upload must not bill twice.
  await client.query("UPDATE knowledge_documents SET ingestion_status='queued',updated_at=NOW() WHERE tenant_id=$1 AND document_id=$2",[tenant,documentId]);
 }else{
  await client.query("UPDATE knowledge_chunks SET embedding=NULL,embedding_status='stale',updated_at=NOW() WHERE tenant_id=$1 AND document_id=$2",[tenant,documentId]);
 }
 return enqueueKnowledgeJob(tenant,documentId,uploadDraft?'parse_and_index':'embed_document',client);
}
