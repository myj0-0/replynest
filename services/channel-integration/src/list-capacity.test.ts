import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {listKnowledgePage,knowledgeListSchema,KnowledgeCursorError} from './knowledge-list.js';
import {ensureConversationMapping} from './conversation-mapping.js';
import {loadConversationPageContext} from './conversation-page-context.js';
test('invalid or cross-tenant cursor rejected before database access',async()=>{
 const db={connect:async()=>{throw Error('must not connect');}} as unknown as pg.Pool;
 await assert.rejects(listKnowledgePage(db,'a','bad'),KnowledgeCursorError);
 const cursor=Buffer.from(JSON.stringify({v:1,tenant:'b',time:'2026-09-28T00:00:00.000000Z',id:'00000000-0000-0000-0000-000000000001'})).toString('base64url');
 await assert.rejects(listKnowledgePage(db,'a',cursor),KnowledgeCursorError);
});
test('real database: microsecond keyset, current-version counts, stable mapping reads and concurrent creation',
 {skip:!process.env.LIST_TEST_DATABASE_URL},async()=>{
 const db=new pg.Pool({connectionString:process.env.LIST_TEST_DATABASE_URL});
 try{
  await db.query(`CREATE TABLE knowledge_documents(document_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT,title TEXT DEFAULT 'synthetic',
   source_type TEXT DEFAULT 'knowledge',version INT DEFAULT 2,status TEXT DEFAULT 'active',content_format TEXT,original_filename TEXT,
   ingestion_status TEXT,scan_status TEXT,parse_status TEXT,file_size BIGINT,valid_from TIMESTAMPTZ,valid_until TIMESTAMPTZ,
   updated_at TIMESTAMPTZ DEFAULT NOW(),created_at TIMESTAMPTZ);
   CREATE TABLE knowledge_chunks(document_id UUID,tenant_id TEXT,document_version INT,embedding_status TEXT);
   CREATE INDEX ON knowledge_chunks(tenant_id,document_id,document_version);
   INSERT INTO knowledge_documents(tenant_id,created_at) SELECT 'a','2026-09-28T00:00:00Z'::timestamptz+i*INTERVAL '1 microsecond' FROM generate_series(1,53) i;
   INSERT INTO knowledge_documents(tenant_id,created_at) VALUES('b',NOW());
   INSERT INTO knowledge_chunks SELECT document_id,tenant_id,2,'ready' FROM knowledge_documents;
   INSERT INTO knowledge_chunks SELECT document_id,tenant_id,1,'ready' FROM knowledge_documents;
   CREATE TABLE conversation_resource_mappings(replynest_resource_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT,resource_type TEXT,
    chatwoot_account_id TEXT,chatwoot_resource_id TEXT,parent_replynest_resource_id UUID,
    UNIQUE(tenant_id,resource_type,chatwoot_account_id,chatwoot_resource_id));`);
  await db.query(knowledgeListSchema);
  const first=await listKnowledgePage(db,'a');assert.equal(first.data.length,20);assert(first.pagination.has_more);
  assert(first.data.every(d=>d.chunk_count===1&&d.ready_chunk_count===1));
  await db.query("UPDATE knowledge_documents SET updated_at=NOW()+INTERVAL '1 day' WHERE tenant_id='a'");
  const second=await listKnowledgePage(db,'a',first.pagination.next_cursor!);
  const third=await listKnowledgePage(db,'a',second.pagination.next_cursor!);
  assert.equal(second.data.length,20);assert.equal(third.data.length,13);assert.equal(third.pagination.has_more,false);
  assert.equal(new Set([...first.data,...second.data,...third.data].map(d=>d.document_id)).size,53);
  assert.equal((await listKnowledgePage(db,'empty')).data.length,0);
  const ids=await Promise.all(Array.from({length:12},()=>ensureConversationMapping(db,'a','conversation','account','upstream')));
  assert.equal(new Set(ids).size,1);
  const before=(await db.query('SELECT xmin::text,ctid::text FROM conversation_resource_mappings WHERE replynest_resource_id=$1',[ids[0]])).rows[0];
  for(let i=0;i<25;i++)assert.equal(await ensureConversationMapping(db,'a','conversation','account','upstream'),ids[0]);
  assert.deepEqual((await db.query('SELECT xmin::text,ctid::text FROM conversation_resource_mappings WHERE replynest_resource_id=$1',[ids[0]])).rows[0],before);
  assert.notEqual(await ensureConversationMapping(db,'b','conversation','account','upstream'),ids[0]);
  assert.notEqual(await ensureConversationMapping(db,'a','conversation','different-account','upstream'),ids[0]);
  await ensureConversationMapping(db,'a','message','account','message');
  const message=await ensureConversationMapping(db,'a','message','account','message',ids[0]);
  assert.equal((await db.query('SELECT parent_replynest_resource_id FROM conversation_resource_mappings WHERE replynest_resource_id=$1',[message])).rows[0].parent_replynest_resource_id,ids[0]);
  await db.query(`CREATE TABLE customers(tenant_id TEXT,customer_id UUID DEFAULT gen_random_uuid(),name TEXT);
   CREATE TABLE channel_identities(tenant_id TEXT,customer_id UUID,chatwoot_conversation_id BIGINT,channel TEXT);
   CREATE TABLE platform_users(platform_user_id UUID DEFAULT gen_random_uuid(),display_name TEXT);
   CREATE TABLE tenant_memberships(tenant_id TEXT,platform_user_id UUID,chatwoot_user_id BIGINT,role TEXT,status TEXT);
   INSERT INTO customers(tenant_id,name) VALUES('a','local customer'),('b','foreign customer');
   INSERT INTO channel_identities SELECT tenant_id,customer_id,10,'shared_wechat' FROM customers;
   INSERT INTO platform_users(display_name) VALUES('local agent'),('foreign agent'),('inactive agent');
   INSERT INTO tenant_memberships SELECT CASE WHEN display_name='foreign agent' THEN 'b' ELSE 'a' END,platform_user_id,
    CASE WHEN display_name='inactive agent' THEN 88 ELSE 77 END,'agent',CASE WHEN display_name='inactive agent' THEN 'disabled' ELSE 'active' END FROM platform_users;`);
  const raw=[{id:10,account_id:'account',meta:{assignee:{id:77}}}];
  let syncCalls=0;
  const firstPage=await loadConversationPageContext(db,'a','account',raw,async()=>{syncCalls++;});
  assert.equal(firstPage.contacts.get('10')?.display_name,'local customer');
  assert.equal(firstPage.assignments.get('77')?.display_name,'local agent');assert.equal(syncCalls,0);
  const sql:string[]=[];
  const counted={query:async(query:string,values:any[])=>{sql.push(query);return db.query(query,values);}} as unknown as Pick<pg.Pool,'query'>;
  await loadConversationPageContext(counted,'a','account',Array.from({length:25},()=>raw[0]),async()=>{throw Error('known profiles must not sync');});
  assert.equal(sql.length,3);assert(sql.every(q=>q.trim().startsWith('SELECT')));
  const unknown=Array.from({length:24},(_,i)=>({id:20+i,account_id:'account',meta:{assignee:{id:88}}}));
  let active=0,peak=0;
  const repaired=await loadConversationPageContext(db,'a','account',unknown,async row=>{
   active++;peak=Math.max(peak,active);
   await db.query("INSERT INTO channel_identities SELECT tenant_id,customer_id,$1,'web_chat' FROM customers WHERE tenant_id='a'",[row.id]);
   active--;
  });
  assert(peak<=4);assert.equal(repaired.contacts.size,24);assert.equal(repaired.assignments.size,0);
  sql.length=0;
  const fullPage=await loadConversationPageContext(counted,'a','account',[...raw,...unknown],async()=>{throw Error('no sync on warm page');});
  assert.equal(fullPage.ids.size,25);assert.equal(fullPage.contacts.size,25);
  assert.equal(sql.length,3);assert(sql.every(q=>q.trim().startsWith('SELECT')));
  let touched=false;const never={query:async()=>{touched=true;throw Error('unexpected');}} as unknown as Pick<pg.Pool,'query'>;
  await assert.rejects(loadConversationPageContext(never,'a','account',[...raw,{id:99,account_id:'foreign'}],async()=>{touched=true;}),/account_mismatch/);
  assert.equal(touched,false);
  await assert.rejects(loadConversationPageContext(never,'a','account',Array.from({length:101},()=>raw[0]),async()=>{}),/page_too_large/);
  assert.equal(touched,false);
 }finally{await db.end();}
});
