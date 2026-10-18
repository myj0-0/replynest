import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrateSharedWechatStore } from "./shared-wechat-store.js";
import { migrateSharedWechatDelivery,type SharedTransport } from "./shared-wechat-delivery.js";
import { processSharedWechatInboundBatch } from "./shared-wechat-worker.js";

test("disabled shared worker performs no DB or transport operations",async()=>{
  const result=await processSharedWechatInboundBatch({connect:async()=>{throw new Error("must not connect");}} as unknown as pg.Pool,{} as SharedTransport,{enabled:false});
  assert.equal(result.selected,0);
  await assert.rejects(processSharedWechatInboundBatch({} as pg.Pool,{} as SharedTransport,{enabled:true,batchSize:51}),/invalid_shared_batch_size/);
});

test("shared worker: concurrent-instance exclusion, tenant queues, uncertain blocking and restart dedup",{skip:!process.env.SHARED_WECHAT_TEST_DATABASE_URL},async()=>{
  const setup=new pg.Pool({connectionString:process.env.SHARED_WECHAT_TEST_DATABASE_URL});await setup.query("CREATE SCHEMA shared_worker_test");await setup.end();
  const db=new pg.Pool({connectionString:process.env.SHARED_WECHAT_TEST_DATABASE_URL,options:"-c search_path=shared_worker_test"});
  const received:string[]=[];
  let entered!:()=>void,release!:()=>void;
  const entry=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
  const transport:SharedTransport={receive:async(target,message,existing)=>{
    received.push(message.eventId);
    if(message.eventId==="a1"){entered();await hold;throw new Error("ambiguous first write");}
    return {accountId:target.accountId,inboxId:target.inboxId,conversationId:existing?.conversationId??"100",messageId:String(received.length)};
  },send:async()=>{throw new Error("must never send to WeChat");}};
  try {
    await db.query(`CREATE TABLE tenants(tenant_id TEXT PRIMARY KEY,name TEXT,status TEXT,chatwoot_account_id BIGINT);
      INSERT INTO tenants VALUES('a','A','test',1),('b','B','test',2);`);
    await migrateSharedWechatStore(db);await migrateSharedWechatDelivery(db);
    await db.query(`INSERT INTO shared_wechat_accounts VALUES('app',TRUE);
      INSERT INTO shared_wechat_enrollments VALUES('app','a',TRUE),('app','b',TRUE);
      INSERT INTO shared_wechat_inboxes VALUES('app','a',1,1,TRUE),('app','b',2,2,TRUE);`);
    for(const [index,event] of ["a1","a2","b1","b2","b3"].entries()) {
      const tenant=event[0];
      await db.query(`INSERT INTO shared_wechat_receipts(app_id,event_id,open_id,request_hash,decision,destination_tenant_id,route_version,text_content,created_at)
        VALUES('app',$1,'same-user','hash',$2,$3,1,'test',NOW()+make_interval(secs=>$4))`,[event,JSON.stringify({action:"route",tenantId:tenant}),tenant,index]);
    }
    const first=processSharedWechatInboundBatch(db,transport,{enabled:true});
    await entry;
    const concurrent=await processSharedWechatInboundBatch(db,transport,{enabled:true});assert.equal(concurrent.locked,true);assert.equal(concurrent.selected,0);
    release();
    const firstResult=await first;assert.equal(firstResult.selected,2);assert.equal(firstResult.uncertain,1);assert.equal(firstResult.delivered,1);
    assert.deepEqual(received,["a1","b1"]);
    await db.query(`UPDATE shared_wechat_enrollments SET enabled=FALSE WHERE tenant_id='b'`);
    assert.equal((await processSharedWechatInboundBatch(db,transport,{enabled:true})).selected,0);
    await db.query(`UPDATE shared_wechat_enrollments SET enabled=TRUE WHERE tenant_id='b'`);
    assert.equal((await processSharedWechatInboundBatch(db,transport,{enabled:true})).delivered,1);
    assert.equal((await processSharedWechatInboundBatch(db,transport,{enabled:true})).delivered,1);
    assert.equal((await processSharedWechatInboundBatch(db,transport,{enabled:true})).selected,0);
    assert.deepEqual(received,["a1","b1","b2","b3"]);
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM shared_wechat_deliveries WHERE command_id='a2'`)).rows[0].n,0);
  }finally{release?.();await db.end();}
});
