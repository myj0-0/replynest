import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {boundedEvidenceQuery,budgetEvidence,RAG_CONTEXT_BYTES,keywordEvidenceSql,historyEvidenceSql,semanticEvidenceSql} from './rag-retrieval.js';

test('context caps include escaped Unicode, deduplicate documents and do not compare score scales',()=>{
 const row={document_id:'one',title:'test',source_type:'manual',version:1,content:'退款',score:.8};
 const result=budgetEvidence([row],[{...row,score:100},...Array.from({length:8},(_,i)=>({...row,document_id:String(i)}))],[]);
 assert.equal(result.knowledge.length,3);assert.equal(result.knowledge[0].retrieval,'semantic');
 const large=budgetEvidence([{...row,content:'😀\u0000'.repeat(9000)}],[row],[]);
 assert(Buffer.byteLength(JSON.stringify(large))<=RAG_CONTEXT_BYTES);assert.equal(large.knowledge.length,1);
});

test('real PostgreSQL: bounded Top-K, tenant/current-version/policy isolation and timeout cleanup',
 {skip:!process.env.RAG_TEST_DATABASE_URL},async()=>{
 const db=new pg.Pool({connectionString:process.env.RAG_TEST_DATABASE_URL,max:1});
 const now=new Date('2026-09-28T00:00:00Z'),policy=randomUUID();
 try{
  await db.query(`CREATE EXTENSION vector;
   CREATE TABLE knowledge_documents(document_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id text,title text,
    source_type text DEFAULT 'manual',version int DEFAULT 2,content text,keywords text[],status text DEFAULT 'active',valid_from timestamptz,valid_until timestamptz);
   CREATE TABLE knowledge_chunks(chunk_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id text,document_id uuid,
    document_version int,chunk_index int,content text,embedding vector(3),embedding_status text DEFAULT 'ready',embedding_provider text DEFAULT 'test',embedding_model text DEFAULT 'test');
   CREATE INDEX ON knowledge_chunks(tenant_id,document_id,document_version,chunk_index);
   CREATE INDEX ON knowledge_documents(tenant_id,status);
   CREATE TABLE historical_reply_examples(example_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id text,
    source_conversation_id text DEFAULT 'synthetic',customer_question text,agent_reply text,intent text DEFAULT 'refund',keywords text[],
    applicable_policy_ids uuid[] DEFAULT '{}',policy_independent boolean DEFAULT false,review_status text DEFAULT 'approved',pii_redacted boolean DEFAULT true);
   CREATE INDEX ON historical_reply_examples(tenant_id,review_status,pii_redacted);
   INSERT INTO knowledge_documents(tenant_id,title,content,keywords)
    SELECT 'tenant-'||(i%500),'synthetic',repeat('合成正文',16000),ARRAY['退款'] FROM generate_series(1,10000) i;
   INSERT INTO knowledge_documents(tenant_id,title,content,keywords)
    SELECT 'target','legacy',repeat('合成正文',16000),ARRAY['退款'] FROM generate_series(1,1000);
   INSERT INTO historical_reply_examples(tenant_id,customer_question,agent_reply,keywords,policy_independent)
    SELECT 'target',repeat('问题',1000),repeat('答案',3000),ARRAY['退款'],true FROM generate_series(1,5000);`);
  const doc=(await db.query(`INSERT INTO knowledge_documents(tenant_id,title,content,keywords)
   VALUES('target','current',repeat('whole document must not return',10000),ARRAY['退款','refund','查询']) RETURNING document_id`)).rows[0].document_id;
  await db.query(`INSERT INTO knowledge_chunks(tenant_id,document_id,document_version,chunk_index,content,embedding)
   VALUES('target',$1,1,0,'STALE SECRET','[1,0,0]'),('other',$1,2,0,'OTHER TENANT SECRET','[1,0,0]'),
   ('target',$1,2,0,'intro','[0,1,0]'),('target',$1,2,1,'退款 refund 查询 current fragment','[1,0,0]')`,[doc]);
  await db.query(`INSERT INTO knowledge_documents(tenant_id,title,content,keywords,status,valid_until)
   VALUES('target','expired','EXPIRED',ARRAY['退款','refund','查询','test'],'active',$1),
   ('target','draft','DRAFT',ARRAY['退款','refund','查询','test'],'draft',NULL)`,[now]);
  const start=performance.now();
  const hits=await boundedEvidenceQuery(db,keywordEvidenceSql,['target',now,'退款 refund 查询 test']);
  assert.equal(hits.rows.length,3);assert.equal(hits.rows[0].document_id,doc);
  assert.equal(hits.rows[0].content,'退款 refund 查询 current fragment');
  assert(hits.rows.every(r=>String(r.content).length<=1200));assert(Buffer.byteLength(JSON.stringify(hits.rows))<17000);
  const semantic=await boundedEvidenceQuery(db,semanticEvidenceSql,['target',now,'[1,0,0]','test','test']);
  assert.equal(semantic.rows.length,2);assert(semantic.rows.every(r=>!String(r.content).includes('SECRET')));
  await db.query(`INSERT INTO historical_reply_examples(tenant_id,customer_question,agent_reply,keywords,applicable_policy_ids)
   VALUES('target','policy','allowed policy reply',ARRAY['退款','refund'],$1::uuid[]),
   ('other','other','OTHER',ARRAY['退款','refund','查询'],$1::uuid[])`,[[policy]]);
  const history=await boundedEvidenceQuery(db,historyEvidenceSql,['target','退款 refund 查询',[policy]]);
  assert.equal(history.rows.length,3);assert.equal(history.rows[0].agent_reply,'allowed policy reply');
  const noPolicy=await boundedEvidenceQuery(db,historyEvidenceSql,['target','退款 refund 查询',[]]);
  assert(noPolicy.rows.every(r=>r.policy_independent===true));
  await db.query("UPDATE historical_reply_examples SET pii_redacted=false WHERE customer_question='policy'");
  assert((await boundedEvidenceQuery(db,historyEvidenceSql,['target','退款 refund 查询',[policy]])).rows.every(r=>r.policy_independent===true));
  await db.query("UPDATE historical_reply_examples SET review_status='pending' WHERE customer_question='policy'");
  assert((await boundedEvidenceQuery(db,historyEvidenceSql,['target','退款 refund 查询',[policy]])).rows.every(r=>r.policy_independent===true));
  await db.query('UPDATE knowledge_documents SET valid_from=$2 WHERE document_id=$1',[doc,new Date('2026-09-29')]);
  assert(!(await boundedEvidenceQuery(db,keywordEvidenceSql,['target',now,'退款 refund 查询'])).rows.some(r=>r.document_id===doc));
  assert.equal((await boundedEvidenceQuery(db,semanticEvidenceSql,['target',now,'[1,0,0]','test','test'])).rowCount,0);
  await db.query('UPDATE knowledge_documents SET valid_from=NULL WHERE document_id=$1',[doc]);
  assert.equal((await boundedEvidenceQuery(db,semanticEvidenceSql,['target',now,'[1,0,0]','wrong','test'])).rowCount,0);
  assert.equal((await boundedEvidenceQuery(db,keywordEvidenceSql,['missing',now,'退款'])).rowCount,0);
  assert.equal((await boundedEvidenceQuery(db,keywordEvidenceSql,['target',now,'unmatched'])).rowCount,0);
  console.log(JSON.stringify({synthetic_documents:11003,synthetic_tenants:502,history_rows:5002,read_checks_ms:Math.round(performance.now()-start),knowledge_result_bytes:Buffer.byteLength(JSON.stringify(hits.rows))}));
  await assert.rejects(boundedEvidenceQuery(db,'SELECT pg_sleep(4)',[]),{code:'57014'});
  assert.equal((await db.query('SHOW statement_timeout')).rows[0].statement_timeout,'0');
  assert.equal((await db.query('SELECT 1 AS ready')).rows[0].ready,1);
 }finally{await db.end();}
});
