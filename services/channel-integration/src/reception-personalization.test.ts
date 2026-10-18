import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import type {Pool} from 'pg';
import {validateReceptionPersonalizationAction,currentReceptionHistoryGrant,receptionHistoryDisclosures} from './reception-personalization.js';
import {receptionPersonalizationDatabaseComponent,receptionPersonalizationRuntimeAcl} from './reception-personalization-component.js';
import {createReceptionPersonalizationApi,receptionPresentationAvailability} from './reception-personalization-api.js';
const settings={expectedRevision:'0',draftTone:'neutral',automaticTone:'concise',learnFromHuman:false,timing:{enabled:true,minimumSeconds:1,maximumSeconds:30}};

test('presentation status requires the actual worker and preparation, distinguishes timing, and closes on shutdown',()=>{
 const state={management:true,stopping:false,draftWorker:true,draftPreparation:true,automaticExecution:true,automaticPreparation:true,timing:true};
 assert.deepEqual(receptionPresentationAvailability(state),{presentation:true,draftTone:true,automaticTone:true,replyTiming:true});
 for(const closed of [{management:false},{stopping:true}])assert.deepEqual(receptionPresentationAvailability({...state,...closed}),
  {presentation:false,draftTone:false,automaticTone:false,replyTiming:false});
 for(const closed of [{draftWorker:false},{draftPreparation:false}])assert.equal(receptionPresentationAvailability({...state,...closed}).draftTone,false);
 for(const closed of [{automaticExecution:false},{automaticPreparation:false}]){
  const result=receptionPresentationAvailability({...state,...closed});assert.equal(result.automaticTone,false);assert.equal(result.replyTiming,false);assert.equal(result.draftTone,true);
 }
 assert.deepEqual(receptionPresentationAvailability({...state,timing:false}),{presentation:true,draftTone:true,automaticTone:true,replyTiming:false});
});
test('settings validation selects only finite presentation fields, never tenant or authority',()=>{
 assert.equal(validateReceptionPersonalizationAction('settings',settings).kind,'settings');
 for(const extra of [{tenantId:'other'},{actorId:'other'},{approved:true},{historyEnabled:true},{expectedRevision:0},{expectedRevision:'01'},
  {draftTone:'female'},{timing:{...settings.timing,maximumSeconds:200}},{learnFromHuman:'true'}])assert.throws(()=>validateReceptionPersonalizationAction('settings',{...settings,...extra}));
});
test('each history purpose requires its own explicit version and no bundled authorization',()=>{
 const v={expectedRevision:'0',purpose:'style',enabled:true,confirmed:true,disclosureVersion:'reception-history-style-v1'};
 assert.equal(validateReceptionPersonalizationAction('history-grant',v).kind,'history-grant');
 for(const extra of [{confirmed:false},{confirmed:undefined},{disclosureVersion:'web-chat-knowledge-semantic-v3'},
  {disclosureVersion:'reception-history-context-v1'},{purpose:'all'},{sendEnabled:true},{purpose:'__proto__'}])
  assert.throws(()=>validateReceptionPersonalizationAction('history-grant',{...v,...extra}));
 assert.deepEqual(validateReceptionPersonalizationAction('history-grant',{expectedRevision:'1',purpose:'style',enabled:false}),{kind:'history-grant',purpose:'style',enabled:false,expectedRevision:'1'});
 assert.match(receptionHistoryDisclosures.knowledgeDraft,/不自动发布/);assert.match(receptionHistoryDisclosures.style,/不将历史原文/);
});
test('component is owner-install only; ACL audit is append-only, no public or destructive grants',async()=>{
 const component=receptionPersonalizationDatabaseComponent();assert.equal(component.name,'reception_personalization');await assert.rejects(component.migrate,/owner_migration_required/);
 const acl=receptionPersonalizationRuntimeAcl('fixture_runtime');assert.match(acl,/GRANT SELECT,INSERT ON TABLE public.reception_personalization_audit/);
 assert.ok(!/GRANT.*DELETE|GRANT.*TRUNCATE|SECURITY DEFINER/.test(acl));assert.ok(acl.includes('FROM PUBLIC'));
 assert.throws(()=>receptionPersonalizationRuntimeAcl('runtime;DROP SCHEMA public'));
});
test('fresh worker grant check binds tenant/account/grant/actor/audit/version, not a boolean',async()=>{
 const calls:any[]=[];const db={query:async(sql:string,args:unknown)=>{calls.push({sql,args});return {rowCount:1};}} as any;
 assert.equal(await currentReceptionHistoryGrant(db,'a','2','style','12345678-1234-1234-1234-123456789abc'),true);
 assert.match(calls[0].sql,/t.chatwoot_account_id::text=\$2/);assert.match(calls[0].sql,/g.grant_id=\$4/);
 assert.match(calls[0].sql,/a.metadata->>'revision'=g.revision::text/);assert.match(calls[0].sql,/m.role='tenant_admin'/);
 assert.equal(calls[0].args.at(-1),'reception-history-style-v1');
 assert.equal(await currentReceptionHistoryGrant(db,'a','2','style','bad'),false);assert.equal(calls.length,1);
});
async function fixture(t:any,enabled:boolean|(()=>boolean)=true,historyEnabled?:()=>boolean){
 let connects=0;const db={connect:async()=>{connects++;throw Error('private_connection_secret');}} as unknown as Pick<Pool,'connect'>;
 const api=createReceptionPersonalizationApi(db,{enabled:typeof enabled==='function'?enabled:()=>enabled,historyEnabled});
 let entered:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 const server=createServer((req,res)=>{entered();void api(req,res,new URL(req.url!,'http://fixture')).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const send=(path='',extra:RequestInit={})=>fetch(origin+'/api/v1/reception-personalization'+path,{headers:{authorization:'Bearer '+'a'.repeat(64),'x-replynest-workspace':'a','content-type':'application/json'},...extra});
 return {send,origin,started,connects:()=>connects};
}
test('actual HTTP denies default-off, unknown routes, query, method and unauthenticated input before DB',async t=>{
 const off=await fixture(t,false);assert.equal((await off.send()).status,404);assert.equal(off.connects(),0);
 const f=await fixture(t);
 for(const [path,extra,status] of [['/wrong',{},405],['?tenant=b',{},405],['/settings',{method:'PUT'},405],['',{headers:{}},401]] as const)
  assert.equal((await f.send(path,extra)).status,status);
 assert.equal(f.connects(),0);
});
test('actual HTTP rejects tenant-selected/oversized/malformed grant requests before DB',async t=>{
 const f=await fixture(t);
 for(const body of [{...settings,tenantId:'b'},null,{},'x'.repeat(5000)]){
  const r=await f.send('/settings',{method:'POST',body:JSON.stringify(body)});assert.ok([400,413].includes(r.status));
 }
 assert.equal(f.connects(),0);
});
test('unknown database outcome is sanitized and does not claim a saved/effective grant',async t=>{
 const f=await fixture(t);const r=await f.send();assert.equal(r.status,503);const body=await r.text();
 assert.ok(!body.includes('private_connection_secret'));assert.ok(!body.includes('已保存'));assert.equal(r.headers.get('cache-control'),'no-store');
});

test('actual HTTP reports independent execution status after authentication and reads; late closure reports all inactive',async t=>{
 for(const close of [false,true]){
  let enabled=true,statusCalls=0;
  const db={connect:async()=>({release(){},async query(sql:string){
   if(sql.includes('FROM console_sessions'))return {rows:[{session_id:'s',tenant_id:'a',platform_user_id:'u',account_id:'1'}]};
   if(sql.includes('RETURNING reads,writes'))return {rows:[{reads:1,writes:0}]};
   if(sql.includes('ORDER BY purpose')&&close)enabled=false;
   return {rows:[]};
  }})} as unknown as Pick<Pool,'connect'>;
  const api=createReceptionPersonalizationApi(db,{enabled:()=>enabled,presentationStatus:()=>{statusCalls++;
   return receptionPresentationAvailability({management:true,stopping:false,draftWorker:true,draftPreparation:true,
    automaticExecution:false,automaticPreparation:true,timing:true});}});
  const server=createServer((req,res)=>{void api(req,res,new URL(req.url!,'http://fixture'));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const response=await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/v1/reception-personalization`,
   {headers:{authorization:'Bearer '+'a'.repeat(64),'x-replynest-workspace':'a'}});
  assert.equal(response.status,200);const {data}=await response.json() as any;
  assert.deepEqual(data.availability,{presentation:!close,draftTone:!close,automaticTone:false,replyTiming:false,history:false});
  assert.equal(statusCalls,close?0:1);
 }
});
test('closing the feature while reading a request body prevents database mutation',async t=>{
 let enabled=true;const f=await fixture(t,()=>enabled),body=JSON.stringify(settings);
 const result=new Promise<number>((resolve,reject)=>{
  const req=httpRequest(f.origin+'/api/v1/reception-personalization/settings',{method:'POST',headers:{authorization:'Bearer '+'a'.repeat(64),'x-replynest-workspace':'a','content-type':'application/json'}},res=>{resolve(res.statusCode!);res.resume();});
  req.on('error',reject);req.write(body.slice(0,1));
  void f.started.then(()=>{enabled=false;req.end(body.slice(1));});
 });
 assert.equal(await result,404);assert.equal(f.connects(),0);
});
test('slow HTTP body has a real two-second deadline without DB access',async t=>{
 const f=await fixture(t);const at=Date.now();
 const status=await new Promise<number>((resolve,reject)=>{
  const req=httpRequest(f.origin+'/api/v1/reception-personalization/settings',{method:'POST',headers:{authorization:'Bearer '+'a'.repeat(64),'x-replynest-workspace':'a','content-type':'application/json'}},res=>{resolve(res.statusCode!);res.resume();req.end();});
  req.on('error',reject);req.write('{');
 });
 assert.equal(status,408);assert.ok(Date.now()-at>=1500&&Date.now()-at<5000);assert.equal(f.connects(),0);
});
test('history tasks reject default-off, invalid query and late shutdown before DB or model job request',async t=>{
 const off=await fixture(t);assert.equal((await off.send('/knowledge-jobs')).status,404);assert.equal(off.connects(),0);
 const f=await fixture(t,true,()=>true);
 for(const q of ['?tenant=b','?cursor=bad&requestId=bad','?requestId=bad'])assert.equal((await f.send('/knowledge-jobs'+q)).status,400);
 assert.equal(f.connects(),0);
 let enabled=true;const closing=await fixture(t,()=>enabled,()=>true),body=JSON.stringify({requestId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',confirmed:true});
 const status=await new Promise<number>((resolve,reject)=>{
  const req=httpRequest(closing.origin+'/api/v1/reception-personalization/knowledge-jobs',{method:'POST',headers:{authorization:'Bearer '+'a'.repeat(64),'x-replynest-workspace':'a','content-type':'application/json'}},res=>{resolve(res.statusCode!);res.resume();});
  req.on('error',reject);req.write(body.slice(0,1));void closing.started.then(()=>{enabled=false;req.end(body.slice(1));});
 });
 assert.equal(status,404);assert.equal(closing.connects(),0);
});
