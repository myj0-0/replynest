import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustomerInsightsIntakeStore,createCustomerInsightsIntakeWorker,type InsightIntake} from './customer-insights-intake.js';
import type {NativeHistoryPage,NativeHistoryRow} from './reception-history-native-client.js';

const uuid='aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',grant='bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const event:InsightIntake={account:'1',inbox:'4',conversation:'10',message:'100',tenantId:'fixture',intakeId:uuid,grantId:grant,generation:2,lease:uuid};
const at='2026-10-11T01:00:00.000000Z',authorized='2026-10-11T00:00:00.000000Z',snapshot='2026-10-11T02:00:00.000000Z';
const row=():NativeHistoryRow=>({account_id:'1',inbox_id:'4',conversation_id:'10',message_id:'100',contact_id:'3',created_at:at,direction:'incoming',author_kind:'customer',text:'想了解配送时间'});
function fixture(){
 const state={enabled:true,context:true,claimed:0,reads:0,enqueued:0,projected:0,metadata:0,finished:[] as string[],afterRead:()=>{},afterMetadata:()=>{},
  scope:{binding:{tenant_id:'fixture',grant_id:grant,generation:2,channel:'web_chat',connection_id:uuid,authorized_at:authorized},customerId:uuid as string|undefined,contactId:'3' as string|undefined,asOf:snapshot},
  response:{outcome:'ready',page:{scanned:1,next_cursor:null,scan_cursor:{created_at:at,message_id:'100'},event_seen_ids:['100'],rows:[row()]}} as {outcome:'ready';page:NativeHistoryPage}|{outcome:'rejected'|'unavailable'}};
 const queue={claim:async()=>{state.claimed++;return event;},context:async()=>state.context?structuredClone(state.scope):null,
  projectWeb:async()=>{state.projected++;if(!state.context)return false;state.scope.customerId=uuid;state.scope.contactId='3';return true;},
  projectShared:async()=>{state.projected++;if(!state.context)return false;state.scope.customerId=uuid;state.scope.contactId='3';return true;},
  finish:async(_e:InsightIntake,status:string)=>{state.finished.push(status);}} as unknown as ReturnType<typeof createCustomerInsightsIntakeStore>;
 const worker=createCustomerInsightsIntakeWorker(queue,{enqueue:async(e,expected)=>{state.enqueued++;assert.deepEqual(e,{tenantId:'fixture',accountId:'1',customerId:uuid,conversationId:'10',messageId:'100'});assert.deepEqual(expected,{grantId:grant,generation:2});return {accepted:true,duplicate:false};}},
  {enabled:()=>state.enabled,native:{page:async input=>{state.reads++;assert.equal(input.purpose,'customerInsights');assert.deepEqual(input.event_ids,['100']);assert.deepEqual(input.contact_ids,['3']);assert.deepEqual(input.after,{created_at:snapshot,message_id:'9223372036854775807'});state.afterRead();return state.response;}},
   readConversation:async()=>{state.metadata++;state.afterMetadata();return {};}});
 return {state,worker,queue};
}
test('default-off intake store and verifier perform no database/native/model work',async()=>{
 let calls=0;const db={query:async()=>{calls++;throw Error();},connect:async()=>{calls++;throw Error();}};
 const intake=createCustomerInsightsIntakeStore(db as any);assert.equal(await intake.admit(event),'ignored');assert.equal(await intake.claim(),null);assert.equal(await intake.context(event),null);assert.equal(await intake.recover(),0);
 const {state,worker}=fixture();state.enabled=false;assert.equal(await worker.runOne(),false);assert.equal(state.claimed,0);assert.equal(state.reads,0);assert.equal(calls,0);
});
test('signed source verification queues only one fenced event; no model or point port exists',async()=>{
 const {state,worker}=fixture();assert.equal(await worker.runOne(),true);assert.equal(state.enqueued,1);assert.equal(state.reads,1);assert.deepEqual(state.finished,['done']);
});
test('missing/revoked context and revocation during source read do not enqueue',async()=>{
 for(const change of ['before','during','disabled'] as const){const {state,worker}=fixture();if(change==='before')state.context=false;else state.afterRead=()=>{if(change==='during')state.context=false;else state.enabled=false;};
  await worker.runOne();assert.equal(state.enqueued,0);assert.deepEqual(state.finished,['ignored']);assert.equal(state.reads,change==='before'?0:1);}
});
test('verified identity drift during read blocks cross-customer publication',async()=>{
 for(const key of ['customerId','contactId'] as const){const {state,worker}=fixture();state.afterRead=()=>{state.scope[key]=key==='customerId'?grant:'5';};await worker.runOne();assert.equal(state.enqueued,0);assert.deepEqual(state.finished,['ignored']);}
});
test('wrong account/inbox/contact/message/direction and pre-grant event cannot trigger a model job',async()=>{
 for(const change of [{account_id:'2'},{inbox_id:'5'},{contact_id:'6'},{conversation_id:'11'},{message_id:'101'},{direction:'outgoing',author_kind:'human'},{created_at:'2026-10-10T23:59:59.999999Z'}]){
  const {state,worker}=fixture();if(state.response.outcome!=='ready')throw Error();state.response.page={...state.response.page,scan_cursor:{created_at:change.created_at??at,message_id:'100'},rows:[{...row(),...change} as NativeHistoryRow]};
  await worker.runOne();assert.equal(state.enqueued,0);assert.deepEqual(state.finished,['ignored']);}
});
test('malformed source text/timestamp/private/AI rows cannot bypass the signed-client boundary',async()=>{
 for(const change of [{private:true},{author_kind:'ai'},{created_at:'2026-02-30T00:00:00.000000Z'},{created_at:'2026-10-11T02:00:00.000001Z'},
  {text:''},{text:'\0'},{text:'\ud800'},{text:'a'.repeat(2001)}]){
  const {state,worker}=fixture();if(state.response.outcome!=='ready')throw Error();state.response.page={...state.response.page,rows:[{...row(),...change} as NativeHistoryRow]};
  await worker.runOne();assert.equal(state.enqueued,0);assert.deepEqual(state.finished,[change.author_kind==='ai'?'ignored':'retry']);}
});
test('filtered media is acknowledged without a generation job; invisible source retries only verification',async()=>{
 for(const seen of [[],['100']]){const {state,worker}=fixture();state.response={outcome:'ready',page:{scanned:0,next_cursor:null,scan_cursor:null,event_seen_ids:seen,rows:[]}};
  await worker.runOne();assert.equal(state.enqueued,0);assert.deepEqual(state.finished,[seen.length?'ignored':'retry']);}
});
test('forged/missing receipt, duplicate source or malformed page is never accepted',async()=>{
 for(const change of [{event_seen_ids:undefined},{event_seen_ids:['101']},{event_seen_ids:['100','100']},{scanned:-1},{scanned:1.5},{scanned:2},{next_cursor:{}},{scan_cursor:null},{rows:[row(),row()]}]){
  const {state,worker}=fixture();if(state.response.outcome!=='ready')throw Error();state.response.page={...state.response.page,...change} as NativeHistoryPage;
  await worker.runOne();assert.equal(state.enqueued,0);assert.deepEqual(state.finished,['retry']);}
});
test('new Web Chat identity uses trusted metadata and rechecks consent before text read',async()=>{
 const {state,worker}=fixture();state.scope.customerId=undefined;state.scope.contactId=undefined;await worker.runOne();assert.equal(state.metadata,1);assert.equal(state.projected,1);assert.equal(state.reads,1);assert.equal(state.enqueued,1);
 const revoked=fixture();revoked.state.scope.contactId=undefined;revoked.state.afterMetadata=()=>{revoked.state.context=false;};await revoked.worker.runOne();assert.equal(revoked.state.reads,0);assert.equal(revoked.state.enqueued,0);
 const shared=fixture();shared.state.scope.contactId=undefined;shared.state.scope.binding.channel='shared_wechat';await shared.worker.runOne();assert.equal(shared.state.metadata,0);assert.equal(shared.state.projected,1);assert.equal(shared.state.enqueued,1);assert.deepEqual(shared.state.finished,['done']);
});
test('verification failure and concurrent calls cannot create duplicate in-flight work',async()=>{
 const {state,worker}=fixture();state.response={outcome:'unavailable'};assert.deepEqual(await Promise.all([worker.runOne(),worker.runOne()]),[true,false]);assert.equal(state.claimed,1);assert.equal(state.enqueued,0);assert.deepEqual(state.finished,['retry']);
});
