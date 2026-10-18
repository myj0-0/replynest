import { pool } from "./database.js";
import { embedText, vectorLiteral } from "./embedding-provider.js";
import { getTenantAiSettings } from "./tenant-ai-settings.js";
import { KnowledgeLeaseLostError,updateJobProgress,withKnowledgeDocumentLease,type KnowledgeJob } from './knowledge-jobs.js';

export async function indexKnowledgeDocument(tenantId: string, documentId: string, allowDraft = false, job?:KnowledgeJob) {
  if(job&&(job.tenant_id!==tenantId||job.document_id!==documentId))throw new KnowledgeLeaseLostError();
  const write=(sql:string,values:unknown[])=>job?withKnowledgeDocumentLease(job,c=>c.query(sql,values)):pool.query(sql,values);
  const document = await pool.query<{ title: string; version: number; status: string }>(
    `SELECT title,version,status FROM knowledge_documents WHERE tenant_id=$1 AND document_id=$2`,
    [tenantId, documentId]
  );
  if (!document.rows[0]) return { status: "not_found" as const, indexed_chunks: 0 };
  if (document.rows[0].status !== "active" && !(allowDraft && document.rows[0].status === "draft")) {
    return { status: "document_inactive" as const, indexed_chunks: 0 };
  }
  const settings = await getTenantAiSettings(tenantId);
  const chunks = await pool.query<{ chunk_id: string; content: string }>(
    `SELECT chunk_id,content FROM knowledge_chunks
      WHERE tenant_id=$1 AND document_id=$2 AND document_version=$3
      AND NOT (embedding_status='ready' AND embedding_provider IS NOT DISTINCT FROM $4 AND embedding_model IS NOT DISTINCT FROM $5)
      ORDER BY chunk_index`,
    [tenantId, documentId,document.rows[0].version,settings.embedding_provider,settings.embedding_model]
  );
  if (!chunks.rows.length) {
    const exists=await pool.query('SELECT 1 FROM knowledge_chunks WHERE tenant_id=$1 AND document_id=$2 AND document_version=$3 LIMIT 1',[tenantId,documentId,document.rows[0].version]);
    return {status:exists.rowCount?'ready' as const:'no_chunks' as const,indexed_chunks:0};
  }
  let indexed = 0;
  try {
    for (const chunk of chunks.rows) {
      if(job){await updateJobProgress(job);await withKnowledgeDocumentLease(job,async()=>undefined);}
      const embedded = await embedText(settings, chunk.content, "RETRIEVAL_DOCUMENT", document.rows[0].title);
      if (!embedded) return { status: "provider_not_configured" as const, indexed_chunks: indexed };
      await write(
        `UPDATE knowledge_chunks SET embedding=$1::vector,embedding_provider=$2,embedding_model=$3,
             embedding_status='ready',updated_at=NOW()
          WHERE tenant_id=$4 AND chunk_id=$5`,
        [vectorLiteral(embedded.vector), embedded.provider, embedded.model, tenantId, chunk.chunk_id]
      );
      indexed += 1;
    }
    return { status: "ready" as const, indexed_chunks: indexed };
  } catch(error) {
    if(error instanceof KnowledgeLeaseLostError)throw error;
    await write(
      `UPDATE knowledge_chunks SET embedding_status='failed',updated_at=NOW()
        WHERE tenant_id=$1 AND document_id=$2 AND embedding_status<>'ready'`,
      [tenantId, documentId]
    );
    return { status: "provider_failed" as const, indexed_chunks: indexed };
  }
}
