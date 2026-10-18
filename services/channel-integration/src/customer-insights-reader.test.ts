import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustomerInsightsReader} from './customer-insights-reader.js';
import type {InsightJob} from './customer-insights-worker.js';
import type {NativeHistoryRow,NativeHistoryPage,HistoryCursor} from './reception-history-native-client.js';
import type {InsightReadBatch} from './customer-insights-store.js';

const job:InsightJob={tenantId:'fixture-tenant',accountId:'1',customerId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',conversationId:'10',grantId:'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',generation:1,revision:0,jobId:'cccccccc-1111-4111-8111-cccccccccccc',lease:'dddddddd-1111-4111-8111-dddddddddddd'};
const asOf='2026-10-11T00:00:00.000000Z';
const row=(id='100',at='2026-10-10T23:59:00.000000Z'):NativeHistoryRow=>({account_id:'1',contact_id:'3',inbox_id:'4',conversation_id:'10',message_id:id,created_at:at,direction:'incoming',author_kind:'customer',text:'希望了解操作方法'});
function fixture(){
 const state={enabled:true,authorized:true,supplyReceipts:true,calls:0,seals:0,batches:[] as InsightReadBatch[],context:{contacts:['3'],known:['fixture@example.test'],lastScanAt:null as string|null,after:null as HistoryCursor|null,asOf,previous:[],eventMessageIds:['100']},pages:[{scanned:1,next_cursor:null,rows:[row()]}] as NativeHistoryPage[],after:()=>{}};
 const reader=createCustomerInsightsReader({authorized:async()=>state.authorized,readContext:async()=>structuredClone(state.context),sealEvidence:async(_job,_rows,snapshot,batch)=>{state.seals++;assert.equal(snapshot,asOf);state.batches.push(batch!);return state.authorized;}},
 {page:async input=>{assert.equal(input.purpose,'customerInsights');assert.equal(input.grant_id,job.grantId);assert.deepEqual(input.contact_ids,['3']);const raw=state.pages[state.calls++],last=raw.rows.at(-1),page={...raw,event_seen_ids:state.supplyReceipts?(raw.event_seen_ids??raw.rows.filter(r=>input.event_ids.includes(r.message_id)).map(r=>r.message_id)):undefined,scan_cursor:raw.scan_cursor===undefined?(raw.next_cursor??(last?{created_at:last.created_at,message_id:last.message_id}:null)):raw.scan_cursor};state.after();return {outcome:'ready',page};}},()=>state.enabled);
 return {state,reader};
}
test('insight history has independent grant, masked text and a fenced snapshot seal',async()=>{
 const {state,reader}=fixture();state.pages[0]={...state.pages[0],rows:[{...row(),text:'fixture@example.test 希望了解操作方法'}]};
 const result=await reader.read(job);assert.equal(state.calls,1);assert.equal(state.seals,1);assert.ok(!result.rows[0].text.includes('fixture@example.test'));assert.equal(result.rows[0].customerId,job.customerId);
});
test('default-off and revoked purpose perform no native read or seal',async()=>{
 for(const flag of ['enabled','authorized'] as const){const {state,reader}=fixture();state[flag]=false;await assert.rejects(reader.read(job));assert.equal(state.calls,0);assert.equal(state.seals,0);}
});
test('revocation and source-binding drift during I/O block snapshot publication',async()=>{
 for(const change of [(s:ReturnType<typeof fixture>['state'])=>{s.authorized=false;},(s:ReturnType<typeof fixture>['state'])=>{s.context.known.push('new@example.test');},(s:ReturnType<typeof fixture>['state'])=>{s.context.contacts.push('5');}]){
  const {state,reader}=fixture();state.after=()=>change(state);await assert.rejects(reader.read(job));assert.equal(state.seals,0);
 }
});
test('late-committed event ID survives the previous snapshot cutoff; old ordinary text does not',async()=>{
 const {state,reader}=fixture();state.context.lastScanAt='2026-10-10T23:59:30.000000Z';state.context.after={created_at:state.context.lastScanAt,message_id:'200'};state.pages[0]={scanned:1,next_cursor:null,rows:[row('100')]};
 const result=await reader.read(job);assert.deepEqual(result.rows.map(r=>r.messageId),['100']);assert.equal(state.seals,1);
});
test('raw port cannot bypass identity, privacy, timestamp, UTF-8 or human source checks',async()=>{
 for(const change of [{account_id:'2'},{contact_id:'5'},{message_id:'0'},{conversation_id:'x'},{inbox_id:'-1'},{created_at:'2026-02-30T00:00:00.000000Z'},{created_at:'2026-10-11T00:00:00.000001Z'},
  {author_kind:'ai'},{private:true},{text:'\0'},{text:'\ud800'},{text:'a'.repeat(2001)}]){
  const {state,reader}=fixture();state.pages[0]={...state.pages[0],rows:[{...row(),...change} as NativeHistoryRow]};await assert.rejects(reader.read(job));assert.equal(state.seals,0);
 }
});
test('duplicate/reordered/overlapping raw rows and malformed cursor fail without sealing',async()=>{
 for(const page of [{scanned:2,next_cursor:null,rows:[row(),row()]},{scanned:2,next_cursor:null,rows:[row('100'),row('99')]},
  {scanned:200,next_cursor:{created_at:'invalid',message_id:'1'},rows:[]},{scanned:1,next_cursor:{created_at:row().created_at,message_id:'100'},rows:[row()]},
  {scanned:200,next_cursor:{created_at:row().created_at,message_id:'99'},rows:[row()]}]){
  const {state,reader}=fixture();state.pages=[page];await assert.rejects(reader.read(job));assert.equal(state.seals,0);
 }
});
test('filtered empty page advances keyset; repeated cursor cannot loop',async()=>{
 const next={created_at:'2026-10-10T23:58:00.000000Z',message_id:'90'};
 const {state,reader}=fixture();state.pages=[{scanned:200,next_cursor:next,rows:[]},{scanned:1,next_cursor:null,rows:[row('100','2026-10-10T23:59:00.000000Z')]}];
 assert.equal((await reader.read(job)).rows.length,1);assert.equal(state.calls,2);
 const f=fixture();f.state.pages=[{scanned:200,next_cursor:next,rows:[]},{scanned:200,next_cursor:next,rows:[]}];await assert.rejects(f.reader.read(job));assert.equal(f.state.seals,0);
});
test('message/character limits seal only the consumed prefix and request continuation',async()=>{
 for(const [count,text] of [[41,'咨询操作'],[7,'问'.repeat(2000)]] as const){
  const {state,reader}=fixture();state.pages=[{scanned:count,next_cursor:null,rows:Array.from({length:count},(_,i)=>({...row(String(200+i)),text}))}];
  const result=await reader.read(job);assert.equal(result.rows.length,count===41?40:6);assert.equal(state.seals,1);assert.equal(state.batches[0].hasMore,true);assert.equal(state.batches[0].cursor.message_id,String(200+result.rows.length-1));
 }
});
test('third full filtered page seals its actual cursor, not a false complete snapshot',async()=>{
 const {state,reader}=fixture();state.pages=Array.from({length:3},(_,i)=>({scanned:200,rows:i===0?[row('10','2026-10-10T23:56:00.000000Z')]:[],next_cursor:{created_at:`2026-10-10T23:${String(57+i).padStart(2,'0')}:00.000000Z`,message_id:String(90+i)}}));
 assert.equal((await reader.read(job)).rows.length,1);assert.equal(state.calls,3);assert.equal(state.batches[0].hasMore,true);assert.equal(state.batches[0].cursor.created_at,'2026-10-10T23:59:00.000000Z');
});

test('empty batches acknowledge only native-seen events, never missing or future events',async()=>{
 for(const seen of [[],['100']]){
  const {state,reader}=fixture();state.context.eventMessageIds=['100','101'];state.pages=[{scanned:0,next_cursor:null,scan_cursor:null,event_seen_ids:seen,rows:[]}];
  assert.equal((await reader.read(job)).rows.length,0);assert.deepEqual(state.batches[0].eventIds,seen);assert.equal(state.batches[0].hasMore,false);
 }
});

test('forged, duplicate or missing native event receipt cannot seal progress',async()=>{
 for(const event_seen_ids of [['101'],['100','100'],['0'],undefined]){
  const {state,reader}=fixture();state.pages=[{scanned:0,next_cursor:null,scan_cursor:null,event_seen_ids,rows:[]}];
  if(event_seen_ids===undefined)state.supplyReceipts=false;
  await assert.rejects(reader.read(job));assert.equal(state.seals,0);
 }
});

test('JSON-escaped byte budget splits a valid batch before losing or charging it',async()=>{
 const {state,reader}=fixture();state.pages=[{scanned:7,next_cursor:null,rows:Array.from({length:7},(_,i)=>({...row(String(200+i)),text:'q'+'\u0001'.repeat(1999)}))}];
 const result=await reader.read(job);assert.equal(result.rows.length,3);assert.equal(state.batches[0].cursor.message_id,'202');assert.equal(state.batches[0].hasMore,true);
});
