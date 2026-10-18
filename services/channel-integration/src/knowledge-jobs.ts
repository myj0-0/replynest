import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { pool } from "./database.js";

export type KnowledgeJob = {
  job_id: string;
  tenant_id: string;
  document_id: string;
  job_type: "parse_and_index" | "embed_document";
  attempts: number;
  max_attempts: number;
  worker_id: string;
};

export async function enqueueKnowledgeJob(
  tenantId: string,
  documentId: string,
  jobType: KnowledgeJob["job_type"],
  client: Pool | PoolClient = pool
) {
  const result = await client.query<{ job_id: string; status: string; created_at: string }>(
    `INSERT INTO knowledge_jobs (tenant_id,document_id,job_type) VALUES ($1,$2,$3)
     RETURNING job_id,status,created_at`, [tenantId, documentId, jobType]
  );
  return result.rows[0];
}

export async function claimKnowledgeJob(workerId: string = randomUUID(), database:Pool=pool): Promise<KnowledgeJob | undefined> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    // Serialize only the short claim transaction, not document processing.
    // Prevent different jobs for the same document from being claimed concurrently.
    const claimLock=await client.query("SELECT pg_try_advisory_xact_lock(hashtext('knowledge-claim-v2')) AS held");
    if(!claimLock.rows[0].held){await client.query('COMMIT');return undefined;}
    await client.query(
      `UPDATE knowledge_jobs SET status='failed',last_error='worker_lock_expired',locked_at=NULL,worker_id=NULL,updated_at=NOW()
        WHERE status='running' AND locked_at<NOW()-INTERVAL '5 minutes'`
    );
    const selected = await client.query<KnowledgeJob>(
      `SELECT job_id,tenant_id,document_id,job_type,attempts,max_attempts
         FROM knowledge_jobs j
        WHERE status IN ('queued','failed') AND scheduled_at<=NOW() AND attempts<max_attempts
          AND NOT EXISTS(SELECT 1 FROM knowledge_jobs running WHERE running.tenant_id=j.tenant_id
            AND running.document_id=j.document_id AND running.status='running')
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`
    );
    if (!selected.rows[0]) { await client.query("COMMIT"); return undefined; }
    const updated = await client.query<KnowledgeJob>(
      `UPDATE knowledge_jobs SET status='running',attempts=attempts+1,worker_id=$2,locked_at=NOW(),updated_at=NOW()
        WHERE job_id=$1
        RETURNING job_id,tenant_id,document_id,job_type,attempts,max_attempts,worker_id`,
      [selected.rows[0].job_id, workerId]
    );
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class KnowledgeLeaseLostError extends Error {
  constructor(){super('knowledge_lease_lost');}
}

// attempts is the monotonically increasing fencing generation; worker_id alone is insufficient.
export async function withKnowledgeLease<T>(job: KnowledgeJob, work:(client:PoolClient)=>Promise<T>, database:Pool=pool):Promise<T>{
  const client=await database.connect();
  try{
    await client.query('BEGIN');
    const held=await client.query(`SELECT 1 FROM knowledge_jobs WHERE job_id=$1 AND tenant_id=$2 AND document_id=$3
      AND worker_id=$4 AND attempts=$5 AND status='running' AND locked_at>NOW()-INTERVAL '5 minutes' FOR UPDATE`,
      [job.job_id,job.tenant_id,job.document_id,job.worker_id,job.attempts]);
    if(!held.rowCount)throw new KnowledgeLeaseLostError();
    const result=await work(client);
    await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export async function updateJobProgress(job: KnowledgeJob, progress?: number, database:Pool=pool) {
  await withKnowledgeLease(job,async client=>{
    await client.query(`UPDATE knowledge_jobs SET progress=COALESCE($2,progress),locked_at=NOW(),updated_at=NOW() WHERE job_id=$1`, [job.job_id, progress??null]);
  },database);
}

export async function withKnowledgeDocumentLease<T>(job:KnowledgeJob,work:(client:PoolClient)=>Promise<T>,database:Pool=pool){
  return withKnowledgeLease(job,async client=>{
    const document=await client.query('SELECT status FROM knowledge_documents WHERE tenant_id=$1 AND document_id=$2 FOR UPDATE',[job.tenant_id,job.document_id]);
    if(!document.rows[0]||!['active','draft'].includes(document.rows[0].status))throw new Error('document_inactive');
    return work(client);
  },database);
}

export async function finishKnowledgeJob(job: KnowledgeJob, status: "succeeded" | "dead", result: Record<string, unknown>, error?: string, database:Pool=pool) {
  await withKnowledgeLease(job,client=>client.query(
    `UPDATE knowledge_jobs SET status=$2,progress=100,result=$3,last_error=$4,locked_at=NULL,worker_id=NULL,updated_at=NOW()
      WHERE job_id=$1`, [job.job_id, status, result, error?.slice(0, 1000) ?? null]
  ),database);
}

export async function retryKnowledgeJob(job: KnowledgeJob, error: unknown, database:Pool=pool) {
  const message = error instanceof Error ? error.message : String(error);
  const terminal = job.attempts >= job.max_attempts || /^document_(?:inactive|parse_rejected|text_limit|input_limit|output_limit|chunk_limit|version_superseded)$/.test(message);
  const delaySeconds = Math.min(300, 2 ** job.attempts);
  await database.query(
    `WITH failed_job AS (UPDATE knowledge_jobs SET status=$2,last_error=$3,scheduled_at=NOW()+($4::text||' seconds')::interval,
       locked_at=NULL,worker_id=NULL,updated_at=NOW()
      WHERE job_id=$1 AND tenant_id=$5 AND document_id=$6 AND worker_id=$7 AND attempts=$8
        AND status='running' AND locked_at>NOW()-INTERVAL '5 minutes' RETURNING tenant_id,document_id,status)
     UPDATE knowledge_documents d SET ingestion_status='failed',updated_at=NOW()
       FROM failed_job j WHERE j.status='dead' AND d.tenant_id=j.tenant_id AND d.document_id=j.document_id
       AND d.status IN ('draft','active') AND d.ingestion_status NOT IN ('rejected','ocr_required')`,
      [job.job_id, terminal ? "dead" : "failed", message.slice(0, 1000), delaySeconds,job.tenant_id,job.document_id,job.worker_id,job.attempts]
  );
}
