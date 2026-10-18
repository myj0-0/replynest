import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {receptionSchema,enqueueReception,claimReception,finishReception,recordReceptionEvent} from './reception-store.js';

// Disposable database only. This test intentionally refuses any other database name.
if(process.env.PGDATABASE!=='reception_isolated_test')throw new Error('isolated_test_database_required');
const db=new Pool();
try {
  await db.query(`CREATE TABLE tenants(tenant_id TEXT PRIMARY KEY,status TEXT,chatwoot_account_id BIGINT);
    CREATE TABLE tenant_ai_settings(tenant_id TEXT PRIMARY KEY,ai_auto_reply_enabled BOOLEAN,automatic_sending_enabled BOOLEAN,automation_updated_at TIMESTAMPTZ);
    CREATE TABLE channel_identities(tenant_id TEXT,channel TEXT,external_user_id TEXT,channel_connection_id UUID,chatwoot_conversation_id BIGINT,customer_id UUID);`);
  await db.query(receptionSchema);
  await db.query(receptionSchema); // Migration is rerunnable.
  const connection=randomUUID();
  await db.query(`INSERT INTO tenants VALUES('a','test',1),('b','test',2);
    INSERT INTO tenant_ai_settings VALUES('a',true,false,NOW(),'automatic-reply-v1'),('b',true,false,NOW(),NULL);`);
  await db.query(`INSERT INTO channel_identities VALUES('a','wechat_official_account','user',$1,10,$2),('b','wechat_official_account','user',$1,20,$3)`,[connection,randomUUID(),randomUUID()]);
  const input={tenantId:'a',channel:'wechat_official_account',externalUserId:'user',connectionId:connection,messageId:'100'};
  assert.equal(await enqueueReception(db,{...input,tenantId:'b'}),0,'legacy preferences are not authorization');
  assert.equal(await enqueueReception(db,{...input,connectionId:randomUUID()}),0,'connection mismatch');
  const tx=await db.connect();await tx.query('BEGIN');await enqueueReception(tx,input);await tx.query('ROLLBACK');tx.release();
  assert.equal((await db.query('SELECT count(*)::int n FROM reception_jobs')).rows[0].n,0,'enqueue must share inbound transaction');
  assert.equal(await enqueueReception(db,input),1);assert.equal(await enqueueReception(db,input),0);
  await db.query("UPDATE reception_jobs SET available_at=NOW()-INTERVAL '1 second'");
  const claims=await Promise.all(Array.from({length:8},()=>claimReception(db)));
  const jobs=claims.filter(j=>!!j);assert.equal(jobs.length,1,'only one worker can claim');
  const j=jobs[0]!;assert.equal(j.tenant_id,'a');assert.equal(j.account_id,'1');assert.equal(j.conversation_id,'10');
  await assert.rejects(()=>finishReception(db,{...j,tenant_id:'b'},'draft','test'));
  await assert.rejects(()=>finishReception(db,{...j,worker_token:randomUUID()},'draft','test'));
  await finishReception(db,j,'draft','test',{text:'synthetic only'});
  assert.equal(await claimReception(db),undefined,'completed drafts are not regenerated');
  await enqueueReception(db,{...input,messageId:'101'});await db.query("UPDATE reception_jobs SET available_at=NOW()-INTERVAL '1 second' WHERE state='queued'");
  const interrupted=await claimReception(db);assert.ok(interrupted);
  await db.query("UPDATE reception_jobs SET locked_at=NOW()-INTERVAL '6 minutes' WHERE job_id=$1",[interrupted.job_id]);
  assert.equal(await claimReception(db),undefined);
  assert.equal((await db.query('SELECT state FROM reception_jobs WHERE job_id=$1',[interrupted.job_id])).rows[0].state,'failed');
  await db.query("UPDATE tenant_ai_settings SET ai_auto_reply_enabled=false WHERE tenant_id='a'");
  assert.equal(await enqueueReception(db,{...input,messageId:'102'}),0,'disabled draft mode does not enqueue');
  // Run the actual worker + persistent state machine against synthetic Chatwoot HTTP responses.
  process.env.POSTGRES_HOST=process.env.PGHOST;process.env.POSTGRES_DATABASE=process.env.PGDATABASE;
  process.env.POSTGRES_USERNAME=process.env.PGUSER;process.env.POSTGRES_PASSWORD=process.env.PGPASSWORD;
  process.env.AI_RECEPTION_DRAFT_WORKER_ENABLED='true';
  process.env.CHATWOOT_BASE_URL='http://chatwoot.invalid';process.env.CHATWOOT_API_ACCESS_TOKEN='synthetic-only';
  const {processReceptionDraft}=await import('./reception-draft-worker.js');
  const {pool}=await import('./database.js');
  const originalFetch=globalThis.fetch;let latestId='103',human=false,uncertain=false,generated=0,notes=0;
  globalThis.fetch=async(url,init)=>{
    if(init?.method==='POST'){
      const body=JSON.parse(String(init.body));assert.equal(body.private,true,'worker must never send public replies');notes++;
      if(uncertain)throw new Error('synthetic connection lost');
      return Response.json({id:500,private:true,conversation_id:10,account_id:1});
    }
    if(String(url).endsWith('/messages'))return Response.json({payload:[{id:latestId,private:false,message_type:human?1:0,conversation_id:10,account_id:1,content:'synthetic question',created_at:Math.floor(Date.now()/1000)}]});
    return Response.json({id:10,account_id:1,status:'open'});
  };
  const generateDraft=async()=>{generated++;return {text:'synthetic private draft',fallback:false};};
  const queue=async(messageId:string)=>{
    latestId=messageId;await db.query("UPDATE tenant_ai_settings SET ai_auto_reply_enabled=true,automation_updated_at=NOW()-INTERVAL '1 minute' WHERE tenant_id='a'");
    await enqueueReception(db,{...input,messageId});await db.query("UPDATE reception_jobs SET available_at=NOW()-INTERVAL '1 second' WHERE state='queued'");
  };
  try {
    await queue('103');assert.equal(await processReceptionDraft({generateDraft}),true);
    assert.equal(generated,1);assert.equal(notes,1);
    assert.equal((await db.query("SELECT state FROM reception_jobs WHERE message_id='103'")).rows[0].state,'draft');
    assert.equal(await processReceptionDraft({generateDraft}),false);assert.equal(generated,1);
    await queue('104');human=true;await processReceptionDraft({generateDraft});assert.equal(generated,1);assert.equal(notes,1);human=false;
    await queue('105');await db.query("UPDATE tenant_ai_settings SET ai_auto_reply_enabled=false WHERE tenant_id='a'");
    await processReceptionDraft({generateDraft});assert.equal(generated,1);
    await queue('106');await processReceptionDraft({generateDraft:async()=>{generated++;human=true;return {text:'synthetic',fallback:false};}});
    assert.equal(notes,1,'human takeover during generation suppresses projection');human=false;
    await queue('107');uncertain=true;await processReceptionDraft({generateDraft});
    assert.equal((await db.query("SELECT state FROM reception_jobs WHERE message_id='107'")).rows[0].state,'uncertain');
    const count=generated;await processReceptionDraft({generateDraft});assert.equal(generated,count,'uncertain outcome must not regenerate');
    console.log('PASS: real draft worker, private-only projection, no duplicate generation, human takeover, opt-out and uncertain note outcome');
    await db.query(`CREATE TABLE customers(customer_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT,name TEXT,email TEXT,phone TEXT);
      ALTER TABLE channel_identities ADD COLUMN chatwoot_source_id TEXT;
      ALTER TABLE channel_identities ADD COLUMN chatwoot_contact_id BIGINT;
      CREATE TABLE channel_connections(connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT,channel_type TEXT,status TEXT,configuration JSONB);
      CREATE TABLE shared_wechat_accounts(app_id TEXT PRIMARY KEY,enabled BOOLEAN);
      CREATE TABLE shared_wechat_enrollments(app_id TEXT,tenant_id TEXT,enabled BOOLEAN);
      CREATE TABLE shared_wechat_inboxes(app_id TEXT,tenant_id TEXT,account_id BIGINT,inbox_id BIGINT,enabled BOOLEAN);
      CREATE TABLE shared_wechat_threads(app_id TEXT,tenant_id TEXT,open_id TEXT,account_id BIGINT,inbox_id BIGINT,conversation_id BIGINT);
      CREATE TABLE shared_wechat_deliveries(app_id TEXT,tenant_id TEXT,open_id TEXT,direction TEXT,status TEXT,upstream_message_id TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),command_id TEXT);
      INSERT INTO shared_wechat_accounts VALUES('shared',true);
      INSERT INTO shared_wechat_enrollments VALUES('shared','a',true);
      INSERT INTO shared_wechat_inboxes VALUES('shared','a',1,5,true);
      INSERT INTO shared_wechat_threads VALUES('shared','a','synthetic-user',1,5,11);
      INSERT INTO shared_wechat_deliveries(app_id,tenant_id,open_id,direction,status,upstream_message_id,command_id)
        VALUES('shared','a','synthetic-user','in','delivered','201','receipt-1');
      INSERT INTO channel_connections(tenant_id,channel_type,status,configuration)
        VALUES('a','web_chat','ready','{"chatwoot_account_id":"1","chatwoot_inbox_id":"6"}');`);
    const {discoverReceptionMessages}=await import('./reception-discovery.js');
    let webMessage='202',sharedMessage='201',webInbox=6,webAccount=1;
    globalThis.fetch=async(url,init)=>{
      const path=String(url),cid=path.includes('/conversations/11')?11:12;
      if(init?.method==='POST'){
        assert.equal(JSON.parse(String(init.body)).private,true);notes++;
        return Response.json({id:600,private:true,conversation_id:cid,account_id:1});
      }
      if(path.includes('/conversations?'))return Response.json({data:{payload:[{id:12,inbox_id:6}]}});
      if(path.endsWith('/messages'))return Response.json({payload:[{id:cid===11?sharedMessage:webMessage,private:false,message_type:0,conversation_id:cid,account_id:1,content:'synthetic only',created_at:Math.floor(Date.now()/1000)}]});
      return Response.json({id:cid,account_id:cid===11?1:webAccount,inbox_id:cid===11?5:webInbox,status:'open',meta:{sender:{id:50,name:'synthetic visitor'}}});
    };
    const discover=async()=>{
      await db.query("UPDATE reception_scan_cursors SET next_at=NOW(),page=1,page_offset=0");
      await discoverReceptionMessages();
      await db.query("UPDATE reception_jobs SET available_at=NOW()-INTERVAL '1 second' WHERE state='queued'");
    };
    await discover();await discover();
    assert.equal((await db.query("SELECT count(*)::int n FROM reception_jobs WHERE message_id IN('201','202')")).rows[0].n,2,'receipt and native discovery are idempotent');
    const priorNotes=notes;
    await processReceptionDraft({generateDraft});await processReceptionDraft({generateDraft});
    assert.equal(notes,priorNotes+2,'both channels create private drafts');
    webMessage='203';webAccount=2;await discover();
    assert.equal((await db.query("SELECT count(*)::int n FROM reception_jobs WHERE message_id='203'")).rows[0].n,0,'canonical foreign account rejected');
    webAccount=1;webInbox=99;await discover();
    assert.equal((await db.query("SELECT count(*)::int n FROM reception_jobs WHERE message_id='203'")).rows[0].n,0,'canonical foreign inbox rejected');
    webInbox=6;await discover();
    await db.query("UPDATE channel_connections SET status='disabled'");
    await processReceptionDraft({generateDraft});assert.equal(notes,priorNotes+2,'disabled web channel suppresses queued draft');
    sharedMessage='204';
    await db.query("INSERT INTO shared_wechat_deliveries(app_id,tenant_id,open_id,direction,status,upstream_message_id,command_id) VALUES('shared','a','synthetic-user','in','delivered','204','receipt-2')");
    await discover();await db.query("UPDATE shared_wechat_enrollments SET enabled=false");
    await processReceptionDraft({generateDraft});assert.equal(notes,priorNotes+2,'disabled shared enrollment suppresses queued draft');
    const {handleConversationHeadlessApi}=await import('./conversation-headless-api.js');
    const {IncomingMessage,ServerResponse}=await import('node:http');
    const {Socket}=await import('node:net');
    const history=async(tenant:string,role:'tenant_admin'|'agent',query='')=>{
      const req=new IncomingMessage(new Socket());req.url='/api/v1/conversation-automation/jobs'+query;req.method='GET';
      const res=new ServerResponse(req);let body='';res.end=((data:unknown)=>{body=String(data);return res;}) as typeof res.end;
      await handleConversationHeadlessApi(req,res,new URL(req.url,'http://local'),{tenant_id:tenant,platform_user_id:randomUUID(),actor_id:'test',auth_kind:'console_session',role},'test');
      return {status:res.statusCode,body:JSON.parse(body)};
    };
    const first=await history('a','tenant_admin','?limit=1');assert.equal(first.status,200);assert.equal(first.body.data.length,1);assert.ok(first.body.next_cursor);
    assert.equal(first.body.data[0].draft,undefined);assert.equal(first.body.data[0].customer_id,undefined);
    const second=await history('a','tenant_admin','?limit=1&before='+first.body.next_cursor);
    assert.notEqual(first.body.data[0].job_id,second.body.data[0].job_id);
    assert.equal((await history('b','tenant_admin','?before='+first.body.next_cursor)).body.data.length,0,'foreign cursor cannot expose jobs');
    assert.equal((await history('a','agent')).status,403);
    assert.equal((await history('a','tenant_admin','?limit=1000')).status,400);
    console.log('PASS: shared/Web Chat discovery, private projection, account/inbox boundaries, channel revocation, job history pagination and access control');
    const {acceptReceptionCallback,processReceptionEvent}=await import('./reception-events.js');
    await db.query("UPDATE channel_connections SET status='ready'");
    const event={event:'message_created',private:false,message_type:0,id:'301',account:{id:1},conversation:{id:12,inbox_id:6}};
    webMessage='301';
    await acceptReceptionCallback({...event,private:true});
    await acceptReceptionCallback({...event,account:{id:2}});
    assert.equal((await db.query('SELECT count(*)::int n FROM reception_events')).rows[0].n,0);
    await acceptReceptionCallback(event);await acceptReceptionCallback(event);
    assert.equal((await db.query('SELECT count(*)::int n FROM reception_events')).rows[0].n,1,'signed duplicate hints deduplicate');
    const consumers=await Promise.all(Array.from({length:8},()=>processReceptionEvent()));
    assert.equal(consumers.filter(Boolean).length,1,'event queue has exclusive claim');
    assert.equal((await db.query("SELECT count(*)::int n FROM reception_jobs WHERE message_id='301'")).rows[0].n,1);
    webMessage='302';await acceptReceptionCallback({...event,id:'302'});
    const workingFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('synthetic outage');};
    await processReceptionEvent();
    assert.equal((await db.query("SELECT state FROM reception_events WHERE message_id='302'")).rows[0].state,'pending','read outage can retry without model consumption');
    globalThis.fetch=workingFetch;
    await db.query("UPDATE reception_events SET available_at=NOW() WHERE message_id='302'");
    await processReceptionEvent();
    assert.equal((await db.query("SELECT state FROM reception_events WHERE message_id='302'")).rows[0].state,'done');
    webMessage='303';await acceptReceptionCallback({...event,id:'303'});
    await db.query("UPDATE reception_events SET state='processing',attempts=1,locked_at=NOW()-INTERVAL '3 minutes' WHERE message_id='303'");
    await processReceptionEvent();
    assert.equal((await db.query("SELECT state FROM reception_events WHERE message_id='303'")).rows[0].state,'done','interrupted source verification resumes');
    await acceptReceptionCallback({...event,id:'304'});
    await db.query("UPDATE tenant_ai_settings SET automation_updated_at=NOW() WHERE tenant_id='a'");
    await processReceptionEvent();
    assert.equal((await db.query("SELECT reason FROM reception_events WHERE message_id='304'")).rows[0].reason,'authorization_changed');
    const receiptTx=await db.connect();await receiptTx.query('BEGIN');
    await recordReceptionEvent(receiptTx,{tenantId:'a',accountId:'1',conversationId:'11',inboxId:'5',messageId:'305',channel:'shared_wechat'});
    await receiptTx.query('ROLLBACK');receiptTx.release();
    assert.equal((await db.query("SELECT count(*)::int n FROM reception_events WHERE message_id='305'")).rows[0].n,0,'receipt rollback also rolls back event');
    console.log('PASS: durable source events, 8-consumer claim, duplicates, interrupted recovery, read retry, consent revocation and transaction rollback');
  }finally{globalThis.fetch=originalFetch;await pool.end();}
  console.log('PASS: migration, transaction rollback, authorization, isolation, deduplication, 8-worker claim race, lease checks, crash recovery and opt-out');
}finally{await db.end();}
