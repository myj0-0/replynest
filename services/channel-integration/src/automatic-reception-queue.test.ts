import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import type {Pool} from 'pg';
import {createAutomaticWebIngress,createAutomaticReceptionQueue} from './automatic-reception-queue.js';
import {expireAutomaticReceptions} from './automatic-reception-store.js';
import type {AutomaticReceptionAdapter} from './automatic-reception-runtime.js';
import type {AutomaticWebTarget} from './automatic-web-chat.js';
const secret='isolated-unit-bridge-secret-000000000000';
const stamp=String(Math.floor(Date.now()/1000));
const signed=(body:Buffer)=>'v1='+createHmac('sha256',secret).update(stamp).update('.').update(body).digest('hex');
function noDatabase(){
 let calls=0;
 const db={query:async()=>{calls++;throw Error('unexpected_data_access');},connect:async()=>{calls++;throw Error('unexpected_connection');}} as unknown as Pool;
 return {db,get calls(){return calls;}};
}
const denied=async()=>({current:false,human:true,replyable:false,question:null,fence:null} as const);
test('ingress and worker require explicit enablement; zero connections by default',async()=>{
 const f=noDatabase();
 assert.equal(await createAutomaticWebIngress(f.db,{secret,snapshot:denied})(Buffer.from('{}'),stamp,''),'disabled');
 const queue=createAutomaticReceptionQueue(f.db,{adapter:{} as AutomaticReceptionAdapter});
 assert.equal(await queue.tick(),0);await queue.stop();assert.equal(await queue.tick(),0);assert.equal(f.calls,0);
});
test('oversize, unsigned, expired and malformed callbacks stop before database access',async()=>{
 const f=noDatabase(),ingress=createAutomaticWebIngress(f.db,{secret,enabled:()=>true,snapshot:denied});
 for(const [body,timestamp,signature] of [[Buffer.alloc(32769),stamp,''],[Buffer.from('{}'),stamp,''],[Buffer.from('{}'),'1000000000','v1='+'0'.repeat(64)]]){
  await assert.rejects(()=>ingress(body as Buffer,timestamp,signature),/unauthorized/);
 }
 for(const body of [Buffer.from([0xff]),Buffer.from('{'),Buffer.from(JSON.stringify({event:'message_created',private:false,message_type:0,id:9007199254740992,account:{id:'1'},inbox:{id:'2'},conversation:{id:'3'}}))]){
  await assert.rejects(()=>ingress(body,stamp,signed(body)),/invalid_automatic_callback/);
 }
 assert.equal(f.calls,0);
});
test('private, outgoing, and unrelated signed events do not use the source adapter',async()=>{
 const f=noDatabase();let snapshots=0;
 const ingress=createAutomaticWebIngress(f.db,{secret,enabled:()=>true,snapshot:async()=>{snapshots++;return denied();}});
 for(const payload of [{event:'message_created',private:true,message_type:0},{event:'message_created',private:false,message_type:1},{event:'conversation_updated'}]){
  const body=Buffer.from(JSON.stringify(payload));assert.equal(await ingress(body,stamp,signed(body)),'ignored');
 }
 assert.equal(f.calls,0);assert.equal(snapshots,0);
});
test('invalid expiry batch does not issue SQL',async()=>{
 const f=noDatabase();for(const limit of [0,101,1.5,NaN])await assert.rejects(()=>expireAutomaticReceptions(f.db,limit),/invalid_automatic_batch/);
 assert.equal(f.calls,0);
});
test('failed worker acquisition releases local single-flight for the next tick',async()=>{
 const f=noDatabase(),queue=createAutomaticReceptionQueue(f.db,{enabled:()=>true,adapter:{} as AutomaticReceptionAdapter});
 await assert.rejects(()=>queue.tick(),/unexpected_connection/);await new Promise<void>(resolve=>setImmediate(resolve));
 await assert.rejects(()=>queue.tick(),/unexpected_connection/);await new Promise<void>(resolve=>setImmediate(resolve));
 await queue.stop();assert.equal(f.calls,2);
});
for(const semantic of [false,true])test(`worker semantic maintenance ${semantic?'enabled':'disabled'} is bounded and never runs model retries`,async()=>{
 const queries:{sql:string;args:unknown[]}[]=[];let releases=0,submissions=0;
 const db={connect:async()=>({release:()=>{releases++;},query:async(sql:string,...args:unknown[])=>{
  queries.push({sql,args});return {rows:sql.includes('pg_try_advisory_lock')?[{locked:true}]:[]};
 }})} as unknown as Pool;
 const queue=createAutomaticReceptionQueue(db,{enabled:()=>true,semanticMaintenanceEnabled:()=>semantic,
  adapter:{enabled:()=>true,generate:async()=>{submissions++;},submit:async()=>{submissions++;}} as unknown as AutomaticReceptionAdapter});
 assert.equal(await queue.tick(),0);await queue.stop();
 const recovery=queries.filter(q=>/WITH stale AS/.test(q.sql)&&/automatic_reception_(retrievals|verifications)/.test(q.sql));
 assert.equal(recovery.length,semantic?2:0);
 for(const q of recovery){const parameters=q.args[0] as unknown[];assert.match(q.sql,/LIMIT \$2 FOR UPDATE SKIP LOCKED/);assert.equal(parameters[0] instanceof Date,true);assert.equal(parameters[1],100);assert.match(q.sql,/SET state='uncertain'/);}
 assert.equal(submissions,0);assert.equal(releases,1);
});

function admissionFixture(){
 const epoch=Date.parse('2026-10-07T05:00:00.000Z');
 let mono=100,enabled=true,clockCalls=0,connects=0,staged=0,committed=0,sourceAt=epoch+10,clockFailure=false;
 let clockGate:Promise<void>|undefined;
 const grant={tenant_id:'synthetic',authorization_id:'10000000-0000-4000-8000-000000000001',
  authorization_at:new Date(epoch-60_000),connection_id:'10000000-0000-4000-8000-000000000002',
  customer_id:'10000000-0000-4000-8000-000000000003',contact_id:'5'};
 const snapshots:AutomaticWebTarget[]=[],elapsed:number[]=[],commands:string[]=[];
 const db={query:async(sql:string,args:unknown[])=>{
  if(sql.includes('admission_ms')){clockCalls++;elapsed.push(Number(args[0]));await clockGate;
   if(clockFailure)throw Error('synthetic clock unavailable');
   return {rows:[{admission_ms:String(epoch+mono-100-Number(args[0]))}]};}
  return {rows:[grant]};
 },connect:async()=>{connects++;let transactionStaged=0;
  return {release:()=>{},query:async(sql:string,args:unknown[])=>{
   commands.push(sql);
   if(sql.includes('SELECT t.tenant_id'))return {rows:[grant]};
   if(sql.includes('tenant_count'))return {rows:[{tenant_count:0,global_count:0}]};
   if(sql.includes('SELECT 1 FROM automatic_reception_jobs WHERE'))return {rows:[],rowCount:0};
   if(sql.startsWith('INSERT INTO automatic_reception_jobs')){staged++;transactionStaged++;return {rows:[{job_id:args[1]}],rowCount:1};}
   if(sql==='COMMIT')committed+=transactionStaged;
   return {rows:[],rowCount:0};
  }};
 }} as unknown as Pool;
 const body=Buffer.from(JSON.stringify({event:'message_created',private:false,message_type:0,id:'4',account:{id:'1'},inbox:{id:'2'},conversation:{id:'3'},created_at:'2099-01-01T00:00:00.000Z'}));
 const ingress=()=>createAutomaticWebIngress(db,{secret,enabled:()=>enabled,monotonicNow:()=>mono,snapshot:async target=>{
  snapshots.push(target);
  // Same source-age decision as the authoritative native endpoint, not a
  // callback-supplied timestamp. The callback deliberately claims 2099.
  if(sourceAt<Date.parse(target.authorizationAt))return denied();
  return {current:true,human:false,replyable:true,question:'synthetic',fence:{revision:'0',conversation_updated_at:'2026-10-07T05:00:00.010Z',
   message_updated_at:'2026-10-07T05:00:00.010Z',question_sha256:'synthetic',customer_pause_revision:'0'}};
 }});
 return {epoch,grant,db,body,ingress,snapshots,elapsed,commands,
  call:(i:ReturnType<typeof createAutomaticWebIngress>)=>i(body,stamp,signed(body)),
  setMono:(v:number)=>{mono=v;},setSource:(v:number)=>{sourceAt=v;},setEnabled:(v:boolean)=>{enabled=v;},
  failClock:(v:boolean)=>{clockFailure=v;},gateClock:(v:Promise<void>|undefined)=>{clockGate=v;},
  totals:()=>({clockCalls,connects,staged,committed})};
}
test('delayed closed-period source is ignored even with fresh signature and forged callback date',async()=>{
 const f=admissionFixture(),ingress=f.ingress();f.setMono(600);f.setSource(f.epoch-1);
 assert.equal(await f.call(ingress),'ignored');assert.deepEqual(f.elapsed,[500]);
 assert.equal(f.snapshots[0].authorizationAt,new Date(f.epoch).toISOString());
 assert.deepEqual(f.totals(),{clockCalls:1,connects:0,staged:0,committed:0});
});
test('fresh source queues after native check; instance cutoff is cached and later grant stays stricter',async()=>{
 const f=admissionFixture(),ingress=f.ingress();f.setMono(600);
 assert.equal(await f.call(ingress),'queued');f.setMono(900);
 f.grant.authorization_at=new Date(f.epoch+5);assert.equal(await f.call(ingress),'queued');
 assert.equal(f.snapshots[1].authorizationAt,new Date(f.epoch+5).toISOString());
 assert.equal(f.grant.authorization_at.toISOString(),new Date(f.epoch+5).toISOString());
 assert.deepEqual(f.totals(),{clockCalls:1,connects:2,staged:2,committed:2});
});
test('new execution instance does not readmit an older source',async()=>{
 const f=admissionFixture(),first=f.ingress();assert.equal(await f.call(first),'queued');
 f.setMono(1000);const second=f.ingress();assert.equal(await f.call(second),'ignored');
 assert.equal(f.snapshots[1].authorizationAt,new Date(f.epoch+900).toISOString());
 assert.equal(f.totals().committed,1);
});
test('observed disable and reenable resets cutoff but does not delete prior jobs',async()=>{
 const f=admissionFixture(),ingress=f.ingress();assert.equal(await f.call(ingress),'queued');
 f.setEnabled(false);assert.equal(await f.call(ingress),'disabled');f.setMono(1000);f.setEnabled(true);
 assert.equal(await f.call(ingress),'ignored');assert.equal(f.totals().committed,1);
});
test('concurrent callbacks share one clock query',async()=>{
 const f=admissionFixture();let release!:()=>void;f.gateClock(new Promise<void>(r=>{release=r;}));
 const ingress=f.ingress(),pending=Promise.all([f.call(ingress),f.call(ingress)]);
 await new Promise(r=>setImmediate(r));assert.equal(f.totals().clockCalls,1);release();
 assert.deepEqual(await pending,['queued','queued']);assert.equal(f.totals().clockCalls,1);
});
test('closing while clock is pending ignores request and later activation cannot reuse old cutoff',async()=>{
 const f=admissionFixture();let release!:()=>void;f.gateClock(new Promise<void>(r=>{release=r;}));
 const ingress=f.ingress(),pending=f.call(ingress);await new Promise(r=>setImmediate(r));
 f.setEnabled(false);assert.equal(await f.call(ingress),'disabled');f.setMono(1000);f.setEnabled(true);release();
 assert.equal(await pending,'ignored');f.gateClock(undefined);assert.equal(await f.call(ingress),'ignored');
 assert.equal(f.totals().connects,0);assert.equal(f.totals().clockCalls,2);
});
test('clock failure is retryable but never reads source or stages jobs',async()=>{
 const f=admissionFixture(),ingress=f.ingress();f.failClock(true);assert.equal(await f.call(ingress),'unavailable');
 assert.equal(f.snapshots.length,0);assert.equal(f.totals().connects,0);
 f.failClock(false);assert.equal(await f.call(ingress),'queued');assert.equal(f.totals().clockCalls,2);
});
test('invalid monotonic clock rejects before database or native work',async()=>{
 const f=admissionFixture(),ingress=f.ingress();f.setMono(99);assert.equal(await f.call(ingress),'unavailable');
 assert.deepEqual(f.totals(),{clockCalls:0,connects:0,staged:0,committed:0});assert.equal(f.snapshots.length,0);
});
