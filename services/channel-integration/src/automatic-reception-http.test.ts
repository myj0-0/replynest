import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import {createAutomaticReceptionHttp} from './automatic-reception-http.js';
const secret='isolated-http-bridge-secret-000000000000';
test('independent customer insights authenticate without opening drafts, sends or workflow ports',async t=>{
 let intake=0,legacy=0;const f=await fixture(t,{enabled:()=>false,insightsEnabled:()=>true,insights:async event=>{intake++;assert.equal(event.message,'1');return 'queued';},
  workflow:async()=>{legacy++;},draft:async()=>{legacy++;},project:async()=>{legacy++;return 'ready';},ingress:async()=>{legacy++;return 'queued';}});
 assert.equal((await f.send(undefined,{headers:{'content-type':'application/json'}})).status,401);
 assert.equal((await f.send({event:'message_created',private:true,message_type:0})).status,200);assert.equal(intake,0);
 const r=await f.send();assert.equal(r.status,200);assert.equal((await r.json()).state,'customer_insights_queued');assert.equal(intake,1);assert.equal(legacy,0);
});
test('old reception enablement does not authorize customer insight admission',async t=>{
 let intake=0;const f=await fixture(t,{insightsEnabled:()=>false,insights:async()=>{intake++;return 'queued';}});
 assert.equal((await f.send()).status,200);assert.equal(intake,0);
});
test('independent queue pressure and errors are retryable without exposing internal details',async t=>{
 let fail=false;const f=await fixture(t,{enabled:()=>false,insightsEnabled:()=>true,insights:async()=>{if(fail)throw Error('private source credentials');return 'backpressure';}});
 let r=await f.send();assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'5');fail=true;r=await f.send();assert.equal(r.status,503);assert.ok(!(await r.text()).includes('credentials'));
});
test('stop drains an authenticated insight admission and refuses new admissions',async t=>{
 let release!:()=>void,started!:()=>void,calls=0;const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{started=r;});
 const f=await fixture(t,{enabled:()=>false,insightsEnabled:()=>true,insights:async()=>{calls++;started();await gate;return 'queued';}});
 const pending=f.send();await ready;let stopped=false;const drain=f.boundary.stop().then(()=>{stopped=true;});assert.equal((await f.send()).status,503);assert.equal(stopped,false);
 release();assert.equal((await pending).status,503);await drain;assert.equal(calls,1);
});
test('opening insights during a body read cannot borrow the already-enabled reception grant',async t=>{
 let on=false,checks=0,intake=0;const f=await fixture(t,{insightsEnabled:()=>{checks++;return on;},insights:async()=>{intake++;return 'queued';}});
 const raw=JSON.stringify({event:'message_created',private:false,message_type:0,id:1,account:{id:2},inbox:{id:3},conversation:{id:4}}),stamp=String(Math.floor(Date.now()/1000));
 const pending=new Promise<number>((resolve,reject)=>{const req=httpRequest(f.origin+'/webhooks/chatwoot/reception',{method:'POST',headers:{'content-type':'application/json',
  'x-replynest-chatwoot-timestamp':stamp,'x-replynest-chatwoot-signature':'v1='+createHmac('sha256',secret).update(stamp+'.'+raw).digest('hex')}},res=>{resolve(res.statusCode!);res.resume();});
  req.on('error',reject);req.write(raw.slice(0,10));const finish=()=>{if(!checks){setImmediate(finish);return;}on=true;req.end(raw.slice(10));};setImmediate(finish);});
 assert.equal(await pending,200);assert.equal(intake,0);
});
async function fixture(t:any,extra:Partial<Parameters<typeof createAutomaticReceptionHttp>[0]>={}){
 const boundary=createAutomaticReceptionHttp({secret,enabled:()=>true,project:async()=> 'ready',ingress:async()=> 'queued',...extra});
 const server=createServer((req,res)=>{void boundary.handle(req,res,new URL(req.url!,'http://local')).then(v=>{if(!v){res.writeHead(404);res.end();}});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 t.after(async()=>{await boundary.stop();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const send=async(payload:unknown={event:'message_created',private:false,message_type:0,id:'1',account:{id:'2'},inbox:{id:'3'},conversation:{id:'4'}},extra:RequestInit={})=>{
  const body=JSON.stringify(payload),stamp=String(Math.floor(Date.now()/1000));
  return fetch(origin+'/webhooks/chatwoot/reception',{method:'POST',headers:{'content-type':'application/json','x-replynest-chatwoot-timestamp':stamp,
   'x-replynest-chatwoot-signature':'v1='+createHmac('sha256',secret).update(stamp).update('.').update(body).digest('hex')},body,...extra});
 };
 return {boundary,origin,send};
}
test('default off, method and signature gates do not call projection or ingress',async t=>{
 let calls=0;const f=await fixture(t,{enabled:()=>false,project:async()=>{calls++;return 'ready';}});
 assert.equal((await f.send()).status,404);assert.equal(calls,0);
 const on=await fixture(t,{project:async()=>{calls++;return 'ready';}});
 assert.equal((await on.send(undefined,{method:'GET',body:undefined})).status,405);
 assert.equal((await on.send(undefined,{headers:{'content-type':'application/json'}})).status,401);
 assert.equal(calls,0);
});
test('studio receives only authenticated public incoming; independently of automatic reception projection',async t=>{
 let events=0;
 const f=await fixture(t,{workflow:async event=>{events++;assert.deepEqual(event,{account:'2',inbox:'3',conversation:'4',message:'1'});},project:async()=> 'ignored'});
 assert.equal((await f.send(undefined,{headers:{'content-type':'application/json'}})).status,401);assert.equal(events,0);
 for(const payload of [{event:'message_created',private:true,message_type:0},{event:'message_created',private:false,message_type:1}])assert.equal((await f.send(payload)).status,200);
 assert.equal(events,0);assert.equal((await f.send()).status,200);assert.equal(events,1);
 const closed=await fixture(t,{enabled:()=>false,closedAck:true,workflow:async()=>{events++;}});
 assert.equal((await closed.send()).status,200);assert.equal(events,1);
});
test('opt-in closed acknowledgement authenticates and never executes any downstream port',async t=>{
 let calls=0;
 const f=await fixture(t,{enabled:()=>false,closedAck:true,draft:async()=>{calls++;},
  project:async()=>{calls++;return 'ready';},ingress:async()=>{calls++;return 'queued';}});
 const r=await f.send();assert.equal(r.status,200);assert.equal((await r.json()).state,'ignored_closed');
 assert.equal((await f.send(undefined,{headers:{'content-type':'application/json'}})).status,401);
 assert.equal((await f.send(undefined,{method:'GET',body:undefined})).status,405);
 assert.equal((await f.send('x'.repeat(32769))).status,413);assert.equal(calls,0);
});
test('closed acknowledgement cannot accept an old signature and remains retryable during process stop',async t=>{
 const f=await fixture(t,{enabled:()=>false,closedAck:true});
 const raw=JSON.stringify({event:'message_created',private:false,message_type:0,id:1,account:{id:2},inbox:{id:3},conversation:{id:4}});
 const stamp=String(Math.floor(Date.now()/1000)-301);
 const r=await f.send(undefined,{headers:{'content-type':'application/json','x-replynest-chatwoot-timestamp':stamp,
  'x-replynest-chatwoot-signature':'v1='+createHmac('sha256',secret).update(stamp+'.'+raw).digest('hex')},body:raw});
 assert.equal(r.status,401);await f.boundary.stop();assert.equal((await f.send()).status,503);
});
test('opening during a closed request body does not retroactively authorize that request',async t=>{
 let on=false,checks=0,calls=0;
 const f=await fixture(t,{closedAck:true,enabled:()=>{checks++;return on;},project:async()=>{calls++;return 'ready';}});
 const raw=JSON.stringify({event:'message_created',private:false,message_type:0,id:1,account:{id:2},inbox:{id:3},conversation:{id:4}});
 const stamp=String(Math.floor(Date.now()/1000));
 const pending=new Promise<{status:number;body:string}>((resolve,reject)=>{
  const req=httpRequest(f.origin+'/webhooks/chatwoot/reception',{method:'POST',headers:{'content-type':'application/json',
   'x-replynest-chatwoot-timestamp':stamp,'x-replynest-chatwoot-signature':'v1='+createHmac('sha256',secret).update(stamp+'.'+raw).digest('hex')}},res=>{
    let text='';res.on('data',b=>{text+=b;});res.on('end',()=>resolve({status:res.statusCode!,body:text}));});
  req.on('error',reject);req.write(raw.slice(0,10));
  const finish=()=>{if(checks===0){setImmediate(finish);return;}on=true;req.end(raw.slice(10));};setImmediate(finish);
 });
 const r=await pending;assert.equal(r.status,200);assert.equal(JSON.parse(r.body).state,'ignored_closed');assert.equal(calls,0);
});
test('HTTP source failures and queue pressure are retryable; successful immutable receipts acknowledged',async t=>{
 let result='backpressure' as any,source='ready' as any,ingressCalls=0;
 const f=await fixture(t,{project:async()=>source,ingress:async()=>{ingressCalls++;return result;}});
 let r=await f.send();assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'5');assert.equal(r.headers.get('cache-control'),'no-store');
 for(const value of ['unavailable','disabled']){result=value;r=await f.send();assert.equal(r.status,503);}
 for(const value of ['queued','duplicate','ignored']){result=value;r=await f.send();assert.equal(r.status,200);assert.equal((await r.json()).state,value);}
 source='unavailable';const before=ingressCalls;r=await f.send();assert.equal(r.status,503);assert.equal(ingressCalls,before);
 source='ignored';r=await f.send();assert.equal(r.status,200);assert.equal(ingressCalls,before);
});
test('errors, private events, query strings and oversized bodies fail without leaking internals',async t=>{
 let calls=0;const f=await fixture(t,{project:async()=>{calls++;throw Error('private database credential detail');}});
 let r=await f.send();assert.equal(r.status,503);assert.ok(!(await r.text()).includes('credential'));
 r=await f.send({event:'message_created',private:true,message_type:0});assert.equal(r.status,200);assert.equal(calls,1);
 r=await f.send('x'.repeat(32769));assert.equal(r.status,413);assert.equal(calls,1);
 r=await fetch(f.origin+'/webhooks/chatwoot/reception?tenant=evil',{method:'POST'});assert.equal(r.status,405);
});
test('slow partial body has a real two-second read deadline',async t=>{
 const f=await fixture(t);const at=Date.now();
 const status=await new Promise<number>((resolve,reject)=>{
  const req=httpRequest(f.origin+'/webhooks/chatwoot/reception',{method:'POST',headers:{'content-type':'application/json'}},res=>{resolve(res.statusCode!);res.resume();req.end();});
  req.on('error',reject);req.write('{');
 });
 assert.equal(status,408);assert.ok(Date.now()-at>=1500&&Date.now()-at<5000);
});
test('callback stop drains in-flight projection, refuses new requests and does not enqueue after stop',async t=>{
 let release!:()=>void,started!:()=>void,ingress=0;const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{started=r;});
 const f=await fixture(t,{project:async()=>{started();await gate;return 'ready';},ingress:async()=>{ingress++;return 'queued';}});
 const pending=f.send();await ready;let stopped=false;const stop=f.boundary.stop().then(()=>{stopped=true;});
 assert.equal((await f.send()).status,503);assert.equal(stopped,false);release();assert.equal((await pending).status,503);await stop;assert.equal(ingress,0);
});
test('at most sixteen callbacks can enter the projection concurrently',async t=>{
 let release!:()=>void,entered=0,all!:()=>void;const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{all=r;});
 const f=await fixture(t,{project:async()=>{if(++entered===16)all();await gate;return 'ready';}});
 const requests=Array.from({length:16},()=>f.send());await ready;const overflow=await f.send();assert.equal(overflow.status,503);assert.equal(entered,16);
 release();await Promise.all(requests);
});
test('draft callback runs only after strict signature, payload and enabled gates',async t=>{
 let drafts=0;const f=await fixture(t,{draft:async()=>{drafts++;},project:async()=> 'ignored'});
 assert.equal((await f.send(undefined,{headers:{'content-type':'application/json'}})).status,401);
 assert.equal((await f.send({event:'message_created',private:true,message_type:0})).status,200);assert.equal(drafts,0);
 const r=await f.send();assert.equal(r.status,200);assert.equal((await r.json()).state,'ignored');assert.equal(drafts,1);
});
test('draft failure is retryable and never proceeds to projection or ingress',async t=>{
 let projections=0;const f=await fixture(t,{draft:async()=>{throw Error('private database detail');},project:async()=>{projections++;return 'ready';}});
 const r=await f.send();assert.equal(r.status,503);assert.equal(r.headers.get('retry-after'),'5');assert.ok(!(await r.text()).includes('private'));assert.equal(projections,0);
});
test('stop drains an in-flight draft and prevents its later automatic projection',async t=>{
 let release!:()=>void,started!:()=>void,projections=0;const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{started=r;});
 const f=await fixture(t,{draft:async()=>{started();await gate;},project:async()=>{projections++;return 'ready';}});
 const pending=f.send();await ready;let done=false;const stop=f.boundary.stop().then(()=>{done=true;});await new Promise(r=>setImmediate(r));assert.equal(done,false);
 release();assert.equal((await pending).status,503);await stop;assert.equal(projections,0);
});
