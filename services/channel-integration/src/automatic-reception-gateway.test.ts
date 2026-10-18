import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {createAutomaticGatewayRuntime} from './automatic-reception-gateway.js';
import type {AutomaticReceptionConfig} from './automatic-reception-config.js';
const bridge='isolated-composition-bridge-key-000000';
const disabled:AutomaticReceptionConfig={management:false,web:false,wechatManagement:false,wechat:false,wechatHistory:false,draftCallback:false,callback:false,bridgeSecret:'',nativeSecret:'',origin:'',token:''};
test('actual composition supports independent insight-only signed admission without legacy executors',async t=>{
 let events=0;const f=await fixture(t,disabled,{insights:{bridgeSecret:bridge,enabled:()=>true,admit:async()=>{events++;return 'queued';}}});
 f.runtime.start();const r=await f.send();assert.equal(r.status,200);assert.equal((await r.json()).state,'customer_insights_queued');assert.equal(events,1);
 assert.deepEqual(f.totals(),{queries:0,drafts:0,schedules:0});assert.equal(await f.runtime.tick(),0);assert.equal(await f.runtime.sender.prepare('1'),'platform_disabled');
 await f.runtime.stop();assert.equal((await f.send()).status,503);assert.equal(events,1);
});
test('independent insight ports remain inert when their separate execution switch is off',async t=>{
 const f=await fixture(t,disabled,{insights:{bridgeSecret:bridge,enabled:()=>false,admit:async()=>{throw Error('must not enqueue');}}});
 f.runtime.start();assert.equal((await f.send()).status,404);assert.deepEqual(f.totals(),{queries:0,drafts:0,schedules:0});
});
test('different bridge keys cannot silently split purpose callback authentication',()=>{
 assert.throws(()=>createAutomaticGatewayRuntime({} as any,{...disabled,bridgeSecret:bridge},{generate:async()=>{throw Error();},draft:async()=>{},
  insights:{bridgeSecret:'other-key',enabled:()=>true,admit:async()=> 'queued'}}),/bridge_mismatch/);
});
async function fixture(t:any,config=disabled,extra:any={}){
 let queries=0,drafts=0,schedules=0;
 const runtime=createAutomaticGatewayRuntime({query:async()=>{queries++;throw Error('must not query');},connect:async()=>{queries++;throw Error('must not connect');}} as any,config,{
  generate:async()=>{throw Error('must not generate');},draft:async()=>{drafts++;},fetcher:async()=>{throw Error('must not fetch');},schedule:()=>{schedules++;return ()=>{};},...extra});
 const server=createServer((req,res)=>{void (async()=>{const url=new URL(req.url!,'http://local');if(await runtime.management(req,res,url)||await runtime.callback(req,res,url))return;res.writeHead(404);res.end();})();});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 t.after(async()=>{await runtime.stop();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const send=()=>{const body=JSON.stringify({event:'message_created',private:false,message_type:0,id:1,account:{id:2},inbox:{id:3},conversation:{id:4}}),stamp=String(Math.floor(Date.now()/1000));
  return fetch(origin+'/webhooks/chatwoot/reception',{method:'POST',headers:{'content-type':'application/json','x-replynest-chatwoot-timestamp':stamp,'x-replynest-chatwoot-signature':'v1='+createHmac('sha256',bridge).update(stamp+'.'+body).digest('hex')},body});};
 return {runtime,origin,send,totals:()=>({queries,drafts,schedules})};
}
test('actual default-off composition exposes no DB, scheduling, model or native writes',async t=>{
 const f=await fixture(t);f.runtime.start();f.runtime.start();assert.equal((await f.send()).status,404);
 assert.equal((await fetch(f.origin+'/api/v1/automatic-reception/management')).status,503);
 assert.equal(await f.runtime.sender.inspect('1'),'platform_disabled');assert.equal(await f.runtime.sender.prepare('1'),'platform_disabled');
 assert.deepEqual(f.totals(),{queries:0,drafts:0,schedules:0});const p=f.runtime.stop();assert.strictEqual(f.runtime.stop(),p);await p;
 assert.equal((await f.send()).status,503);assert.throws(()=>f.runtime.start(),/automatic_reception_stopping/);
});
test('actual closed-ack composition acknowledges signed callbacks with zero database/model/native work',async t=>{
 const f=await fixture(t,{...disabled,closedCallbackAck:true,bridgeSecret:bridge});f.runtime.start();
 const r=await f.send();assert.equal(r.status,200);assert.equal((await r.json()).state,'ignored_closed');
 assert.deepEqual(f.totals(),{queries:0,drafts:0,schedules:0});
 assert.equal(await f.runtime.tick(),0);assert.equal(await f.runtime.tickWaiting(),0);
 await f.runtime.stop();assert.equal((await f.send()).status,503);
});
test('actual legacy-draft composition accepts authenticated incoming events without automatic tables',async t=>{
 const f=await fixture(t,{...disabled,callback:true,draftCallback:true,bridgeSecret:bridge});f.runtime.start();
 const r=await f.send();assert.equal(r.status,200);assert.equal((await r.json()).state,'ignored');
 assert.deepEqual(f.totals(),{queries:0,drafts:1,schedules:0});
});

test('WeChat management-only composition does not resolve credentials or schedule a sender',async t=>{
 const f=await fixture(t,{...disabled,management:true,wechatManagement:true},{wechat:{credentials:{
  readIndependent:async()=>{throw Error('must not read credentials');},readShared:async()=>{throw Error('must not read credentials');}}}});
 f.runtime.start();assert.equal((await f.send()).status,404);
 assert.deepEqual(f.totals(),{queries:0,drafts:0,schedules:0});
});
test('WeChat-only execution schedules once, leaves callbacks disabled and drains a failed batch',async t=>{
 let next:(()=>void)|undefined,scheduled=0,cancelled=0,reports:unknown[]=[];
 const f=await fixture(t,{...disabled,management:true,wechatManagement:true,wechat:true,origin:'http://isolated-native.invalid',nativeSecret:bridge},{
  schedule:(callback:()=>void)=>{next=callback;scheduled++;return ()=>{cancelled++;};},report:(...v:unknown[])=>reports.push(v)});
 f.runtime.start();f.runtime.start();assert.equal(scheduled,1);assert.equal((await f.send()).status,404);
 next!();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(reports,[['unavailable',0]]);assert.equal(scheduled,2);assert.equal(f.totals().queries,1);
 const p=f.runtime.stop();assert.strictEqual(f.runtime.stop(),p);await p;
 assert.equal(cancelled,1);next!();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.totals().queries,1);
});

test('identity management can prepare a signed actor while every execution path remains closed',async t=>{
 const calls:Array<{path:string;operation:string}>=[];
 const f=await fixture(t,{...disabled,management:true,wechatManagement:true,senderManagement:true,
  origin:'http://isolated-native.invalid',nativeSecret:bridge},{fetcher:async(url:string,init:RequestInit)=>{
   const input=JSON.parse(String(init.body));
   assert.ok(new Headers(init.headers).get('x-automatic-signature'));
   calls.push({path:new URL(url).pathname,operation:input.operation});
   return Response.json({account_id:input.account_id,state:'ready'});
  }});
 f.runtime.start();f.runtime.start();
 assert.equal(await f.runtime.sender.inspect('1'),'ready');assert.equal(await f.runtime.sender.prepare('1'),'ready');
 assert.deepEqual(calls,[{path:'/internal/saas_sso/automatic_replies/actor',operation:'inspect'},
  {path:'/internal/saas_sso/automatic_replies/actor',operation:'prepare'}]);
 assert.equal(await f.runtime.tick(),0);assert.equal(await f.runtime.tickWaiting(),0);
 assert.equal((await f.send()).status,404);
 const unauthorized=await fetch(f.origin+'/api/v1/automatic-reception/management');assert.equal(unauthorized.status,401);
 assert.deepEqual(f.totals(),{queries:0,drafts:0,schedules:0});
 await f.runtime.stop();assert.equal(await f.runtime.sender.prepare('1'),'platform_disabled');assert.equal(calls.length,2);
});
test('actual server composition exposes signed sender preparation and does not treat readiness as consent',async t=>{
 const config={...disabled,management:true,web:true,origin:'http://isolated-native.invalid',nativeSecret:bridge,token:'isolated-read-token'};
 const operations:string[]=[];let release:()=>void=()=>{};
 const f=await fixture(t,config,{fetcher:async(_url:string,init:RequestInit)=>{
  const input=JSON.parse(String(init.body));operations.push(input.operation);
  if(operations.length===3)await new Promise<void>(resolve=>{release=resolve;});
  return Response.json({account_id:input.account_id,state:'ready'});
 }});
 assert.equal(await f.runtime.sender.inspect('1'),'ready');assert.equal(await f.runtime.sender.prepare('1'),'ready');
 assert.deepEqual(f.totals(),{queries:0,drafts:0,schedules:0});
 const pending=f.runtime.sender.prepare('1');await new Promise(resolve=>setImmediate(resolve));await f.runtime.stop();release();
 assert.equal(await pending,'platform_disabled','shutdown during initialization cannot approve a new grant');
 assert.equal(await f.runtime.sender.prepare('1'),'platform_disabled');assert.equal(operations.length,3);
});
test('timing cannot be silently registered without its trusted persistent-presentation port',()=>{
 assert.throws(()=>createAutomaticGatewayRuntime({} as any,{...disabled,web:true,timing:true},{generate:async()=>{throw Error();},draft:async()=>{}}),/timing_ports_required/);
 assert.throws(()=>createAutomaticGatewayRuntime({} as any,{...disabled,timing:true},{generate:async()=>{throw Error();},draft:async()=>{}}),/timing_ports_required/);
});
test('actual gateway due-loop is independent of a stalled generation batch and stops both loops',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 let connects=0,releases=0,cancelled=0;const callbacks:Array<{fn:()=>void;ms:number}>=[];
 const db={connect:async()=>{const n=++connects;if(n===1)await gate;
  return {query:async(sql:string)=>sql.includes('pg_try_advisory_lock')?{rows:[{locked:false}]}:{rows:[],rowCount:0},release:()=>{releases++;}};},query:async()=>{throw Error('unexpected pool query');}} as any;
 const runtime=createAutomaticGatewayRuntime(db,{...disabled,web:true,timing:true,origin:'http://isolated-native.invalid',nativeSecret:bridge,token:'isolated-read-token'},{
  generate:async()=>{throw Error('must not model');},draft:async()=>{},fetcher:async()=>{throw Error('must not native');},
  timing:{presentationOptions:{enabled:()=>true},currentPresentation:async()=>false},
  schedule:(fn,ms)=>{callbacks.push({fn,ms});return ()=>{cancelled++;};}});
 runtime.start();runtime.start();assert.deepEqual(callbacks.map(v=>v.ms),[3000,500]);
 callbacks.find(v=>v.ms===3000)!.fn();await new Promise(r=>setImmediate(r));assert.equal(connects,1);
 callbacks.find(v=>v.ms===500)!.fn();await new Promise(r=>setImmediate(r));
 assert.equal(connects,4);assert.equal(releases,3);assert.equal(callbacks.at(-1)!.ms,500);
 let done=false;const stop=runtime.stop().then(()=>{done=true;});await new Promise(r=>setImmediate(r));assert.equal(done,false);
 release();await stop;assert.equal(releases,4);assert.equal(cancelled,2);
 assert.equal(await runtime.tickWaiting(),0);assert.equal(await runtime.tick(),0);
});
