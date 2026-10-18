import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';

// No production env loading. The real integration URL is supplied by an isolated runner.
for(const name of ['POSTGRES_HOST','POSTGRES_DATABASE','POSTGRES_USERNAME','POSTGRES_PASSWORD'])process.env[name]??='synthetic-unused';
const {withKnowledgeLease,withKnowledgeDocumentLease,KnowledgeLeaseLostError,claimKnowledgeJob,updateJobProgress,finishKnowledgeJob,retryKnowledgeJob}=await import('./knowledge-jobs.js');
const job={job_id:'j',tenant_id:'t',document_id:'d',worker_id:'w',attempts:2,max_attempts:3,job_type:'parse_and_index' as const};

test('lease guard fails closed before invoking mutation and rolls back',async()=>{
  const calls:string[]=[];let mutated=false,released=false;
  const database={connect:async()=>({query:async(sql:string,values?:unknown[])=>{
    calls.push(sql);if(sql.startsWith('SELECT')){assert.match(sql,/attempts=\$5/);assert.match(sql,/locked_at>/);assert.match(sql,/FOR UPDATE/);assert.deepEqual(values,['j','t','d','w',2]);return {rowCount:0};}return {};
  },release:()=>{released=true;}})} as unknown as pg.Pool;
  await assert.rejects(withKnowledgeLease(job,async()=>{mutated=true;},database),KnowledgeLeaseLostError);
  assert.equal(mutated,false);assert.equal(released,true);assert.equal(calls.at(-1),'ROLLBACK');
});

test('real PostgreSQL: expired generation cannot write, heartbeat renews and same-document jobs serialize',
  {skip:!process.env.KNOWLEDGE_TEST_DATABASE_URL},async()=>{
  const db=new pg.Pool({connectionString:process.env.KNOWLEDGE_TEST_DATABASE_URL});
  try{
    await db.query(`CREATE TABLE knowledge_jobs(job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL,document_id TEXT NOT NULL,
      job_type TEXT DEFAULT 'parse_and_index',attempts INT DEFAULT 0,max_attempts INT DEFAULT 3,status TEXT DEFAULT 'queued',
      scheduled_at TIMESTAMPTZ DEFAULT NOW(),created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW(),locked_at TIMESTAMPTZ,
      worker_id TEXT,progress INT DEFAULT 0,last_error TEXT,result JSONB);
      CREATE TABLE guarded_results(id TEXT PRIMARY KEY,value INT);INSERT INTO guarded_results VALUES('result',0);
      CREATE TABLE knowledge_documents(tenant_id TEXT,document_id TEXT,status TEXT,ingestion_status TEXT DEFAULT 'parsed',updated_at TIMESTAMPTZ DEFAULT NOW());
      INSERT INTO knowledge_documents(tenant_id,document_id,status) VALUES('tenant-a','document-a','draft');`);
    const id=randomUUID();await db.query("INSERT INTO knowledge_jobs(job_id,tenant_id,document_id) VALUES($1,'tenant-a','document-a')",[id]);
    const first=await claimKnowledgeJob('worker',db);assert.ok(first);assert.equal(first.attempts,1);
    await db.query("INSERT INTO knowledge_jobs(tenant_id,document_id) VALUES('tenant-a','document-a')");
    assert.equal(await claimKnowledgeJob('other',db),undefined);
    await db.query("UPDATE knowledge_jobs SET locked_at=NOW()-INTERVAL '4 minutes' WHERE job_id=$1",[id]);
    await updateJobProgress(first,20,db);
    assert.equal((await db.query("SELECT locked_at>NOW()-INTERVAL '5 seconds' AS fresh FROM knowledge_jobs WHERE job_id=$1",[id])).rows[0].fresh,true);
    await db.query("UPDATE knowledge_jobs SET locked_at=NOW()-INTERVAL '6 minutes' WHERE job_id=$1",[id]);
    // Reuse the same worker name to prove the generation, not just worker_id, fences writes.
    const second=await claimKnowledgeJob('worker',db);assert.ok(second);assert.equal(second.job_id,id);assert.equal(second.attempts,2);
    await assert.rejects(withKnowledgeLease(first,c=>c.query("UPDATE guarded_results SET value=999"),db),KnowledgeLeaseLostError);
    await assert.rejects(finishKnowledgeJob(first,'succeeded',{},undefined,db),KnowledgeLeaseLostError);
    await retryKnowledgeJob(first,new Error('stale'),db);
    assert.equal((await db.query('SELECT status FROM knowledge_jobs WHERE job_id=$1',[id])).rows[0].status,'running');
    await withKnowledgeLease(second,c=>c.query('UPDATE guarded_results SET value=1'),db);
    await db.query("UPDATE knowledge_documents SET status='inactive'");
    await assert.rejects(withKnowledgeDocumentLease(second,c=>c.query('UPDATE guarded_results SET value=999'),db),/document_inactive/);
    await finishKnowledgeJob(second,'succeeded',{},undefined,db);
    assert.equal((await db.query('SELECT value FROM guarded_results')).rows[0].value,1);
    assert.ok(await claimKnowledgeJob('other',db));
  }finally{await db.end();}
});
