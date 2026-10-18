import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { WeChatSendRejected } from "./wechat-send-error.js";
import { migrateSharedWechatStore, recordSharedWechatEvent } from "./shared-wechat-store.js";
import { sceneToken } from "./shared-wechat-routing.js";
import {receptionSchema} from './reception-store.js';
import { migrateSharedWechatDelivery, deliverSharedWechatInbound, sendSharedWechatManualReply, type SharedTransport, type SharedManualReply } from "./shared-wechat-delivery.js";

test("offline two-tenant delivery: fixed recipients, notes, authorization, dedup and ambiguous writes",{skip:!process.env.SHARED_WECHAT_TEST_DATABASE_URL},async()=>{
  const setup=new pg.Pool({connectionString:process.env.SHARED_WECHAT_TEST_DATABASE_URL});
  await setup.query("CREATE SCHEMA shared_delivery_test"); await setup.end();
  const db=new pg.Pool({connectionString:process.env.SHARED_WECHAT_TEST_DATABASE_URL,options:"-c search_path=shared_delivery_test"});
  const received: {tenantId:string;key:string}[]=[],sent:{tenantId:string;openId:string;content:string}[]=[];
  let uncertainReceive=false,uncertainSend=false;
  const transport:SharedTransport={
    receive:async(target,message,existing)=>{
      received.push({tenantId:target.tenantId,key:message.contactKey});
      if(uncertainReceive) throw new Error("timeout after possible write");
      return {accountId:target.accountId,inboxId:target.inboxId,conversationId:existing?.conversationId ?? (target.tenantId==="a"?"101":"202"),messageId:String(received.length)};
    },
    send:async(target,message)=>{sent.push({tenantId:target.tenantId,openId:target.openId,content:message.content});if(uncertainSend)throw new Error("timeout after possible send");}
  };
  try {
    await db.query(`CREATE TABLE tenants(tenant_id TEXT PRIMARY KEY,name TEXT,status TEXT,chatwoot_account_id BIGINT UNIQUE);
      INSERT INTO tenants VALUES('a','商家A','test',11),('b','商家B','test',22)`);
    await migrateSharedWechatStore(db); await migrateSharedWechatDelivery(db);
    await db.query(`CREATE TABLE tenant_ai_settings(tenant_id TEXT PRIMARY KEY,ai_auto_reply_enabled BOOLEAN,automatic_sending_enabled BOOLEAN,automation_updated_at TIMESTAMPTZ);
      INSERT INTO tenant_ai_settings VALUES('a',true,false,NOW()),('b',true,false,NOW());`);
    await db.query(receptionSchema);
    await db.query("UPDATE tenant_ai_settings SET automation_consent_version='automatic-reply-v1'");
    await db.query(`INSERT INTO shared_wechat_accounts VALUES('app',TRUE);
      INSERT INTO shared_wechat_enrollments VALUES('app','a',TRUE),('app','b',TRUE);
      INSERT INTO shared_wechat_inboxes VALUES('app','a',11,1,TRUE),('app','b',22,2,TRUE)`);
    const base=Date.now()-30000;
    const event=(id:string,second:number,text="hello")=>({appId:"app",openId:"same-user",eventId:id,occurredAt:base+second*1000,kind:"text" as const,text});
    const a=sceneToken(),b=sceneToken();
    for(const [tenant,token] of [["a",a],["b",b]] as const) await db.query(`INSERT INTO shared_wechat_scenes VALUES('app',$1,$2,NOW()+INTERVAL '10 minutes',FALSE)`,[token.digest,tenant]);
    await recordSharedWechatEvent(db,{...event("scan-a",0),kind:"scan",text:undefined,event:"SCAN",eventKey:a.value});
    await recordSharedWechatEvent(db,event("a-message",1));
    const switched=await recordSharedWechatEvent(db,{...event("scan-b",2),kind:"scan",text:undefined,event:"SCAN",eventKey:b.value});
    const code=switched.decision.state.choices!.items.find(c=>c.tenantId==="b")!.code;
    await recordSharedWechatEvent(db,event("choice-b",3,`选择 ${code}`));
    await recordSharedWechatEvent(db,event("b-message",4));
    // Process A's old event after switching to B: still A's inbox.
    const parallel=await Promise.all([deliverSharedWechatInbound(db,"app","a-message",transport),deliverSharedWechatInbound(db,"app","a-message",transport)]);
    assert(parallel.includes("delivered")); assert.equal(received.length,1);
    assert.equal(await deliverSharedWechatInbound(db,"app","a-message",transport),"duplicate");
    assert.equal(await deliverSharedWechatInbound(db,"app","b-message",transport),"delivered");
    if(process.env.AI_RECEPTION_DRAFT_WORKER_ENABLED==='true'){
      const events=await db.query('SELECT tenant_id,account_id,conversation_id FROM reception_events ORDER BY tenant_id');
      assert.deepEqual(events.rows,[{tenant_id:'a',account_id:'11',conversation_id:'101'},{tenant_id:'b',account_id:'22',conversation_id:'202'}]);
    }
    assert.deepEqual(received.map(r=>r.tenantId),["a","b"]); assert.notEqual(received[0].key,received[1].key); assert(!received[0].key.includes("same-user"));
    const reply:SharedManualReply={appId:"app",tenantId:"a",accountId:"11",conversationId:"101",commandId:"reply-a",actorId:"agent-a",content:"您好",private:false};
    const allow=async()=>true;
    assert.equal(await sendSharedWechatManualReply(db,reply,async()=>false,transport),"blocked");
    assert.equal(await sendSharedWechatManualReply(db,{...reply,private:true},allow,transport),"private_note"); assert.equal(sent.length,0);
    assert.equal(await sendSharedWechatManualReply(db,{...reply,tenantId:"b"},allow,transport),"blocked");
    assert.equal(await sendSharedWechatManualReply(db,reply,allow,transport),"delivered");
    assert.deepEqual(sent[0],{tenantId:"a",openId:"same-user",content:"【商家A】\n您好"});
    assert.equal(await sendSharedWechatManualReply(db,reply,allow,transport),"duplicate"); assert.equal(sent.length,1);
    assert.equal(await sendSharedWechatManualReply(db,{...reply,content:"altered"},allow,transport),"blocked");
    await db.query(`UPDATE shared_wechat_enrollments SET enabled=FALSE WHERE tenant_id='a'`);
    assert.equal(await sendSharedWechatManualReply(db,{...reply,commandId:"disabled"},allow,transport),"blocked");
    await db.query(`UPDATE shared_wechat_enrollments SET enabled=TRUE WHERE tenant_id='a'`);
    let rejectedCalls=0;
    const rejectedTransport={...transport,send:async()=>{rejectedCalls++;throw new WeChatSendRejected(45047);}};
    const rejected={...reply,commandId:"quota-rejected"};
    assert.equal(await sendSharedWechatManualReply(db,rejected,allow,rejectedTransport),"shared_rate_limited");
    assert.equal(await sendSharedWechatManualReply(db,rejected,allow,rejectedTransport),"shared_rate_limited");
    assert.equal(rejectedCalls,1);
    uncertainSend=true;
    const unknown={...reply,commandId:"unknown"};
    assert.equal(await sendSharedWechatManualReply(db,unknown,allow,transport),"uncertain");
    assert.equal(await sendSharedWechatManualReply(db,unknown,allow,transport),"uncertain"); assert.equal(sent.length,2);
    await recordSharedWechatEvent(db,event("b-timeout",5)); uncertainReceive=true;
    assert.equal(await deliverSharedWechatInbound(db,"app","b-timeout",transport),"uncertain");
    assert.equal(await deliverSharedWechatInbound(db,"app","b-timeout",transport),"uncertain");
    await recordSharedWechatEvent(db,event("b-after-timeout",6));
    assert.equal(await deliverSharedWechatInbound(db,"app","b-after-timeout",transport),"blocked"); assert.equal(received.length,3);
    await recordSharedWechatEvent(db,{...event("unsub",7),kind:"unsubscribe",text:undefined});
    assert.equal(await sendSharedWechatManualReply(db,{...reply,commandId:"after-unsub"},allow,transport),"blocked");
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM shared_wechat_deliveries WHERE status='uncertain'`)).rows[0].n,2);
  } finally {await db.end();}
});
