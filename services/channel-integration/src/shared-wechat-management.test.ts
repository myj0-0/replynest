import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createServer } from "node:http";
import { migrateSharedWechatStore } from "./shared-wechat-store.js";
import { migrateSharedWechatManagement,manageSharedWechat,sharedWechatOverview } from "./shared-wechat-management.js";
import { handleSharedWechatManagement } from "./shared-wechat-management-api.js";

test("tenant QR management: requests do not approve, gates, tenant ownership, revocation and rate limits",{skip:!process.env.SHARED_WECHAT_TEST_DATABASE_URL},async()=>{
  const setup=new pg.Pool({connectionString:process.env.SHARED_WECHAT_TEST_DATABASE_URL});await setup.query("CREATE SCHEMA shared_management_test");await setup.end();
  const db=new pg.Pool({connectionString:process.env.SHARED_WECHAT_TEST_DATABASE_URL,options:"-c search_path=shared_management_test"});
  let calls=0;
  const options={appId:"app",entryReady:false,issueQr:async(scene:string)=>{calls++;assert.match(scene,/^rn_[A-Za-z0-9_-]{32}$/);return {imageUrl:"https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=test",expiresIn:600};}};
  const actor={tenantId:"a",actorId:"admin-a",role:"tenant_admin"};
  try {
    await db.query(`CREATE TABLE tenants(tenant_id TEXT PRIMARY KEY,name TEXT,status TEXT,chatwoot_account_id BIGINT UNIQUE);INSERT INTO tenants VALUES('a','A','test',1),('b','B','test',2)`);
    await migrateSharedWechatStore(db);await migrateSharedWechatManagement(db);
    await manageSharedWechat(db,actor,{action:"request"},options);await manageSharedWechat(db,actor,{action:"request"},options);
    assert.equal((await sharedWechatOverview(db,"a",options)).requested,true);assert.equal((await sharedWechatOverview(db,"a",options)).enabled,false);
    assert.equal((await sharedWechatOverview(db,"b",options)).requested,false);
    await assert.rejects(manageSharedWechat(db,{...actor,role:"agent"},{action:"request"},options),/admin_required/);
    await assert.rejects(manageSharedWechat(db,actor,{action:"create_qr",tenant_id:"b"},options),/invalid_input/);
    await assert.rejects(manageSharedWechat(db,actor,{action:"create_qr"},options),/entry_not_ready/);assert.equal(calls,0);
    await db.query(`INSERT INTO shared_wechat_accounts VALUES('app',TRUE);INSERT INTO shared_wechat_enrollments VALUES('app','a',TRUE),('app','b',TRUE);INSERT INTO shared_wechat_inboxes VALUES('app','a',1,11,TRUE),('app','b',2,22,TRUE)`);
    options.entryReady=true;
    assert.equal((await sharedWechatOverview(db,"a",options)).entry_ready,true);
    const qr=await manageSharedWechat(db,actor,{action:"create_qr"},options);assert.equal(calls,1);
    assert.equal((await sharedWechatOverview(db,"b",options)).scenes.length,0);
    await assert.rejects(manageSharedWechat(db,{...actor,tenantId:"b"},{action:"revoke_qr",digest:qr.digest},options),/qr_not_found/);
    await assert.rejects(manageSharedWechat(db,actor,{action:"create_qr"},options),/qr_rate_limited/);assert.equal(calls,1);
    await manageSharedWechat(db,actor,{action:"revoke_qr",digest:qr.digest},options);
    assert.equal((await sharedWechatOverview(db,"a",options)).scenes[0].revoked,true);
    await manageSharedWechat(db,actor,{action:"disable"},options);
    assert.equal((await sharedWechatOverview(db,"a",options)).entry_ready,false);
    await manageSharedWechat(db,actor,{action:"request"},options);assert.equal((await sharedWechatOverview(db,"a",options)).enabled,false);
    assert.equal((await db.query(`SELECT enabled FROM shared_wechat_enrollments WHERE tenant_id='b'`)).rows[0].enabled,true);
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM shared_wechat_management_events WHERE tenant_id='a'`)).rows[0].n,6);
    const permanentOptions={...options,issueQr:async(_scene:string,permanent?:boolean)=>{
      assert.equal(permanent,true);return {imageUrl:"https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=permanent-test",expiresIn:null};
    }};
    const permanent=await manageSharedWechat(db,{...actor,tenantId:"b"},{action:"create_qr",permanent:true},permanentOptions);
    assert.equal(permanent.expires_at,null);
    assert.equal((await sharedWechatOverview(db,"b",permanentOptions)).scenes[0].expires_at,null);
    await manageSharedWechat(db,{...actor,tenantId:"b"},{action:"revoke_qr",digest:permanent.digest},permanentOptions);
    assert.equal((await sharedWechatOverview(db,"b",permanentOptions)).scenes[0].revoked,true);
  } finally {await db.end();}
});

test("management HTTP: disabled read is explicit, non-admin denied before DB, failures sanitized",async()=>{
  const db={query:async()=>{throw new Error("secret DB detail");}} as unknown as pg.Pool;
  const auth={tenant_id:"a",actor_id:"admin",role:"tenant_admin"};
  const deps={db,enabled:false,options:{appId:"app",entryReady:false,issueQr:async()=>{throw new Error("unexpected network");}}};
  const server=createServer(async(req,res)=>{await handleSharedWechatManagement(req,res,new URL(req.url!,"http://local"),auth,"request",deps);});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert(address&&typeof address!=="string");
  const url=`http://127.0.0.1:${address.port}/api/v1/channels/shared-wechat`;
  try {
    const disabled=await fetch(url);assert.equal((await disabled.json() as any).data.available,false);assert.match(disabled.headers.get("cache-control")!,/no-store/);
    assert.equal((await fetch(url,{method:"POST",body:'{"action":"request"}'})).status,409);
    auth.role="agent";assert.equal((await fetch(url)).status,403);auth.role="tenant_admin";deps.enabled=true;
    assert.equal((await fetch(url,{method:"POST",body:"invalid"})).status,400);
    const failed=await fetch(url);assert.equal(failed.status,503);assert(!JSON.stringify(await failed.json()).includes("secret"));
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
