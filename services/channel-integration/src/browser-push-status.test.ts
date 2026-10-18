import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {handleBrowserPushApi} from "./browser-push-api.js";
import {pool} from "./database.js";
test("push status is scoped to current member, tenant and exact endpoint",async()=>{
  const original=pool.query;
  let calls=0;
  pool.query=(async(_sql:unknown,values:unknown[])=>{calls++;assert.equal(values[0],'tenant-a');assert.equal(values[1],'user-a');assert.match(String(values[2]),/^[a-f0-9]{64}$/);return {rows:[{exists:1}]};}) as any;
  const auth={tenant_id:'tenant-a',actor_id:'user-a',platform_user_id:'user-a',auth_kind:'console_session' as const};
  const server=createServer(async(req,res)=>{await handleBrowserPushApi(req,res,new URL(req.url!,'http://local'),auth,'test');});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert(a&&typeof a!=='string');
  const data={endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{p256dh:'a'.repeat(87),auth:'b'.repeat(22)},expected_tenant_id:'tenant-a',expected_user_id:'user-a'};
  const endpoint=`http://127.0.0.1:${a.port}/api/v1/browser-push/subscriptions/status`;
  async function request(body:unknown){return fetch(endpoint,{method:'POST',body:JSON.stringify(body)});}
  try {
    const valid=await request(data);assert.equal(valid.status,200);assert.equal((await valid.json() as any).data.active,true);
    assert.equal((await request({...data,expected_tenant_id:'tenant-b'})).status,409);
    assert.equal((await request({...data,expected_user_id:'user-b'})).status,409);
    assert.equal((await request({...data,endpoint:'http://127.0.0.1'})).status,400);
    assert.equal(calls,1);
  } finally {pool.query=original;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
