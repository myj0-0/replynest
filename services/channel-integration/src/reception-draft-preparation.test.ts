import test from 'node:test';
import assert from 'node:assert/strict';
import {createReceptionDraftPreparation} from './reception-draft-preparation.js';
const job={job_id:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',worker_token:'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
 customer_id:'cccccccc-1111-4111-8111-cccccccccccc',tenant_id:'merchant-a',account_id:'2',conversation_id:'3',message_id:'4',channel:'shared_wechat',authorization_at:new Date('2026-10-06T00:00:00Z')};
function fixture(){
 const state={connections:0,enabled:true,context:true,grant:true,live:true,revision:'1',binding:'41',draftTone:'concise',reads:0,queries:[] as string[],changedSample:false};
 const db={connect:async()=>{state.connections++;return {release:()=>{state.connections--;},query:async(sql:string)=>{
  state.queries.push(sql);
  if(sql.startsWith('SELECT to_char(j.authorization_at'))return {rows:state.live?[{authorization:'2026-10-06T00:00:00.123456Z'}]:[],rowCount:state.live?1:0};
  if(sql.startsWith('SELECT DISTINCT i.chatwoot_contact_id'))return {rows:[{contact:state.binding,name:'synthetic',email:null,phone:null}]};
  if(sql.startsWith('SELECT draft_tone'))return {rows:[{draft_tone:state.draftTone,revision:state.revision,learn_from_human:false}]};
  if(sql.startsWith('SELECT grant_id'))return {rows:state.grant?[{grant_id:'dddddddd-1111-4111-8111-dddddddddddd'}]:[]};
  if(sql.startsWith('SELECT 1 FROM reception_history_grants'))return {rowCount:state.grant?1:0,rows:[]};
  if(sql.startsWith('UPDATE reception_jobs')){state.live=false;return {rowCount:1,rows:[{}]};}
  return {rows:[],rowCount:0};
 }};}} as any;
 const reader={read:async(scope:any)=>{
  state.reads++;assert.equal(state.connections,0);assert.equal(scope.customerId,job.customer_id);assert.equal(scope.accountId,job.account_id);assert.equal(scope.purpose,'context');
  return {purpose:'context' as const,privacyPolicy:'history-redaction-v1' as const,sampleDigest:(state.changedSample?'b':'a').repeat(64),asOf:'2026-10-06T00:00:00.000000Z',pages:1,scanned:1,
   messages:[{tenantId:job.tenant_id,accountId:job.account_id,customerId:job.customer_id,conversationId:'3',messageId:'1',createdAtMs:Date.parse('2026-10-05T00:00:00Z'),direction:'incoming' as const,authorKind:'customer' as const,private:false,deleted:false,text:'邮箱：foo@example.invalid，电话13800138000'}]};
 }};
 const service=createReceptionDraftPreparation(db,reader,{enabled:()=>state.enabled,contextEnabled:()=>state.context});return {db,reader,state,service};
}
test('default off and unissued/cross-service preparations cannot access or commit',async()=>{
 const f=fixture(),off=createReceptionDraftPreparation(f.db,f.reader);
 await assert.rejects(()=>off.prepare(job),/unavailable/);assert.equal(f.state.queries.length,0);assert.equal(f.state.reads,0);
 const invented={presentation:{tone:'concise' as const,context:[]}};
 assert.equal(await f.service.current(invented),false);assert.equal(await f.service.commitProjection(invented,{}),false);
 const prepared=await f.service.prepare(job);assert.equal(await off.current(prepared),false);
 assert.equal(await f.service.current({...prepared}),false);
});
test('chosen draft preset without context consent needs no history read',async()=>{
 const f=fixture();f.state.grant=false;const p=await f.service.prepare(job);
 assert.equal(p.presentation.tone,'concise');assert.deepEqual(p.presentation.context,[]);assert.equal(f.state.reads,0);
 assert.equal(await f.service.current(p,{rereadHistory:true}),true);assert.equal(f.state.connections,0);
});
test('authorized masked context drops IDs, releases DB during I/O and rechecks source',async()=>{
 const f=fixture(),p=await f.service.prepare(job);assert.equal(f.state.reads,1);
 assert.doesNotMatch(JSON.stringify(p),/foo@example|13800138000|customerId|grantId|merchant-a|cccccccc/);
 assert.match(p.presentation.context[0].text,/已隐藏/);
 assert.equal(await f.service.current(p,{rereadHistory:true}),true);assert.equal(f.state.reads,2);
 f.state.changedSample=true;assert.equal(await f.service.current(p,{rereadHistory:true}),false);
 assert.equal(f.state.connections,0);
});
test('lease, binding, config, context grant, shutdown changes invalidate before projection',async()=>{
 for(const change of ['live','binding','revision','grant','context','enabled']){
  const f=fixture(),p=await f.service.prepare(job);
  if(change==='live')f.state.live=false;if(change==='binding')f.state.binding='42';if(change==='revision')f.state.revision='2';
  if(change==='grant')f.state.grant=false;if(change==='context')f.state.context=false;if(change==='enabled')f.state.enabled=false;
  assert.equal(await f.service.current(p),false);
  if(change!=='live')assert.equal(await f.service.commitProjection(p,{}),false);
  else await assert.rejects(()=>f.service.commitProjection(p,{}),/draft_projection_uncertain/);
  assert.ok(!f.state.queries.some(q=>q.startsWith('UPDATE reception_jobs')));assert.equal(f.state.connections,0);
 }
});
test('projection barrier shares settings/grant lock and cannot be replayed',async()=>{
 const f=fixture(),p=await f.service.prepare(job);assert.equal(await f.service.commitProjection(p,{text:'synthetic draft'}),true);
 assert.equal(await f.service.current(p),false);await assert.rejects(()=>f.service.commitProjection(p,{}),/draft_projection_uncertain/);
 assert.equal(f.state.queries.filter(q=>q.startsWith('UPDATE reception_jobs')).length,1);
 assert.ok(f.state.queries.includes('SELECT pg_advisory_xact_lock(714207,hashtext($1))'));assert.equal(f.state.connections,0);
});
