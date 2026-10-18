import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pool } from "./database.js";
import {bootstrapDatabaseRuntime} from './database-runtime.js';
import {databaseComponents} from './database-components.js';
import { parseDocument } from "./document-parser.js";
import { scanWithClamAv, type UploadedFormat } from "./file-security.js";
import { prepareCleanCopy, readStored, removeStored } from "./file-storage.js";
import { chunkText, contentChecksum } from "./knowledge-ingestion.js";
import { indexKnowledgeDocument } from "./knowledge-indexer.js";
import { claimKnowledgeJob, finishKnowledgeJob, retryKnowledgeJob, updateJobProgress, withKnowledgeLease, withKnowledgeDocumentLease, type KnowledgeJob } from "./knowledge-jobs.js";
import { DOCUMENT_LIMITS } from './document-parser-limits.js';

const workerId = `knowledge-${randomUUID()}`;

async function processJob(job: KnowledgeJob) {
  const write=(sql:string,values:unknown[])=>withKnowledgeDocumentLease(job,c=>c.query(sql,values));
  await withKnowledgeDocumentLease(job,async()=>undefined);
  if (job.job_type === "embed_document") {
    const indexed = await indexKnowledgeDocument(job.tenant_id, job.document_id,false,job);
    if (indexed.status === "provider_failed" || indexed.status === "provider_not_configured") throw new Error(indexed.status);
    if (indexed.status !== "ready") return finishKnowledgeJob(job, "dead", indexed, indexed.status);
    await write(`UPDATE knowledge_documents SET ingestion_status='ready',updated_at=NOW() WHERE tenant_id=$1 AND document_id=$2`, [job.tenant_id, job.document_id]);
    return finishKnowledgeJob(job, "succeeded", indexed);
  }
  const document = await pool.query<{
    storage_key: string; content_format: UploadedFormat; title: string; version: number;
  }>(`SELECT storage_key,content_format,title,version FROM knowledge_documents WHERE tenant_id=$1 AND document_id=$2`, [job.tenant_id, job.document_id]);
  if (!document.rows[0]?.storage_key) return finishKnowledgeJob(job, "dead", { status: "source_missing" }, "source_missing");
  const data = await readStored(document.rows[0].storage_key);
  await updateJobProgress(job, 10);
  const scan = await scanWithClamAv(data);
  if (!scan.clean) {
    await write(
      `UPDATE knowledge_documents SET status='inactive',scan_status='infected',parse_status='blocked',ingestion_status='rejected',updated_at=NOW()
        WHERE tenant_id=$1 AND document_id=$2`, [job.tenant_id, job.document_id]
    );
    await withKnowledgeLease(job,()=>removeStored(document.rows[0].storage_key));
    return finishKnowledgeJob(job, "dead", { status: "infected" }, scan.result);
  }
  await write(`UPDATE knowledge_documents SET scan_status='clean',updated_at=NOW() WHERE tenant_id=$1 AND document_id=$2`, [job.tenant_id, job.document_id]);
  const cleanStorageKey = await withKnowledgeDocumentLease(job,()=>prepareCleanCopy(document.rows[0].storage_key));
  if (cleanStorageKey !== document.rows[0].storage_key) {
    await write(
      `UPDATE knowledge_documents SET storage_key=$3,updated_at=NOW() WHERE tenant_id=$1 AND document_id=$2 AND storage_key=$4`,
      [job.tenant_id, job.document_id, cleanStorageKey, document.rows[0].storage_key]
    );
    await withKnowledgeLease(job,()=>removeStored(document.rows[0].storage_key));
  }
  await updateJobProgress(job, 30);
  const parsed = await parseDocument(document.rows[0].content_format, data);
  if (parsed.ocrRequired) {
    await write(
      `UPDATE knowledge_documents SET parse_status='ocr_required',ingestion_status='ocr_required',updated_at=NOW()
        WHERE tenant_id=$1 AND document_id=$2`, [job.tenant_id, job.document_id]
    );
    return finishKnowledgeJob(job, "succeeded", { status: "ocr_required", metadata: parsed.metadata });
  }
  const chunks = chunkText(parsed.text);
  if (!chunks.length) throw new Error("Parser produced no chunks");
  if (chunks.length>DOCUMENT_LIMITS.chunks) throw new Error('document_chunk_limit');
  await withKnowledgeDocumentLease(job,async client=>{
    const prior=await client.query(`SELECT content_checksum FROM knowledge_documents WHERE tenant_id=$1 AND document_id=$2 FOR UPDATE`,[job.tenant_id,job.document_id]);
    const existing=await client.query('SELECT COUNT(*)::int AS count FROM knowledge_chunks WHERE tenant_id=$1 AND document_id=$2 AND document_version=$3',[job.tenant_id,job.document_id,document.rows[0].version]);
    // A retry must retain already billed, ready embeddings for identical parsed content.
    if(prior.rows[0]?.content_checksum===contentChecksum(parsed.text)&&existing.rows[0].count===chunks.length)return;
    await client.query(`DELETE FROM knowledge_chunks WHERE tenant_id=$1 AND document_id=$2`, [job.tenant_id, job.document_id]);
    await client.query(
      `UPDATE knowledge_documents SET content=$3,content_checksum=$4,parse_status='parsed',ingestion_status='parsed',updated_at=NOW()
        WHERE tenant_id=$1 AND document_id=$2`, [job.tenant_id, job.document_id, parsed.text, contentChecksum(parsed.text)]
    );
    for (let index = 0; index < chunks.length; index += 1) {
      await client.query(
        `INSERT INTO knowledge_chunks (tenant_id,document_id,document_version,chunk_index,content,embedding_status)
         VALUES ($1,$2,$3,$4,$5,'pending')`, [job.tenant_id, job.document_id, document.rows[0].version, index, chunks[index]]
      );
    }
  });
  await updateJobProgress(job, 60);
  const indexed = await indexKnowledgeDocument(job.tenant_id, job.document_id, true,job);
  if (indexed.status === "provider_failed") throw new Error(indexed.status);
  if(!['ready','provider_not_configured'].includes(indexed.status))throw new Error('document_inactive');
  const finalStatus = indexed.status === "ready" ? "ready" : "parsed";
  await withKnowledgeLease(job,async activation=>{
    await activation.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2,0))`, [job.tenant_id, document.rows[0].title]);
    // Match upload's title-lock -> document-row lock ordering.
    const current=await activation.query('SELECT status FROM knowledge_documents WHERE tenant_id=$1 AND document_id=$2 FOR UPDATE',[job.tenant_id,job.document_id]);
    if(!current.rows[0]||!['draft','active'].includes(current.rows[0].status))throw new Error('document_inactive');
    const newer=await activation.query('SELECT 1 FROM knowledge_documents WHERE tenant_id=$1 AND title=$2 AND version>$3 LIMIT 1',[job.tenant_id,document.rows[0].title,document.rows[0].version]);
    if(newer.rowCount)throw new Error('document_version_superseded');
    await activation.query(
      `UPDATE knowledge_documents SET status='inactive',updated_at=NOW()
        WHERE tenant_id=$1 AND title=$2 AND status='active' AND document_id<>$3`,
      [job.tenant_id, document.rows[0].title, job.document_id]
    );
    await activation.query(
      `UPDATE knowledge_documents SET status='active',ingestion_status=$3,updated_at=NOW()
        WHERE tenant_id=$1 AND document_id=$2`,
      [job.tenant_id, job.document_id, finalStatus]
    );
  });
  return finishKnowledgeJob(job, "succeeded", {
    status: finalStatus, chunks: chunks.length, indexed_chunks: indexed.indexed_chunks, metadata: parsed.metadata
  });
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  let job: KnowledgeJob | undefined;
  try {
    job = await claimKnowledgeJob(workerId);
    if (job) {
      const claimed=job;let heartbeat:Promise<void>|undefined;
      const timer=setInterval(()=>{if(!heartbeat)heartbeat=updateJobProgress(claimed).catch(()=>{/* All writes recheck the lease. */}).finally(()=>{heartbeat=undefined;});},30_000);
      try{await processJob(job);}finally{clearInterval(timer);await heartbeat;}
    }
  } catch (error) {
    if (job) await retryKnowledgeJob(job, error);
    else console.error("Knowledge worker claim failed", error);
  } finally {
    busy = false;
  }
}

await bootstrapDatabaseRuntime(pool,databaseComponents(process.env,'knowledge'),process.env);
console.log(`knowledge-worker started: ${workerId}`);
const healthServer = createServer(async (request, response) => {
  if (request.method !== "GET" || request.url !== "/health") { response.writeHead(404).end(); return; }
  try {
    await pool.query("SELECT 1");
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: "ok", busy }));
  } catch {
    response.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: "unavailable" }));
  }
});
healthServer.listen(Number(process.env.HEALTH_PORT ?? 3002), "0.0.0.0");
setInterval(() => void tick(), 1_000);
void tick();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => { healthServer.close(); await pool.end(); process.exit(0); });
}
