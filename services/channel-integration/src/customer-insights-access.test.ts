import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {createInsightPermissionClient,createInsightAccessPort,type InsightPermissionInput} from './customer-insights-access.js';
import {publicInsightProjection} from './customer-insights-api.js';
const input:InsightPermissionInput={account_id:'1',contact_id:'2',conversation_id:'3',native_actor_id:'4',native_actor_email:'fixture@example.invalid',purpose:'customerInsights'};
const secret='synthetic-only-'.repeat(4),path='/internal/saas_sso/customer_insights_history/permission';
const response=(body:string)=>({account_id:'1',contact_id:'2',conversation_id:'3',native_actor_id:'4',assigned:true,request_sha256:createHash('sha256').update(body).digest('hex')});
test('permission client signs exact fixed metadata path and returns only assignment',async()=>{
 const call=createInsightPermissionClient({origin:'https://native.invalid',secret,fetcher:async(url,options)=>{
  assert.equal(url,'https://native.invalid'+path);assert.equal(options?.redirect,'error');const body=options!.body as string,h=options!.headers as Record<string,string>;
  assert.deepEqual(JSON.parse(body),input);assert.equal(h['x-automatic-signature'],createHmac('sha256',secret).update(`${path}\n${h['x-automatic-timestamp']}\n${h['x-automatic-nonce']}\n${body}`).digest('hex'));
  return Response.json(response(body));
 }});assert.deepEqual(await call(input),{assigned:true});
});
test('permission fails closed for forged identity/hash, duplicate keys, extra fields and excessive response',async()=>{
 for(const mutate of [(v:any)=>({...v,assigned:'true'}),(v:any)=>({...v,account_id:'9'}),(v:any)=>({...v,request_sha256:'0'.repeat(64)}),(v:any)=>({...v,email:'private'}),
  (v:any)=>JSON.stringify(v).replace('"assigned":true','"assigned":true,"assigned":true'),()=> 'x'.repeat(4097)]){
  const call=createInsightPermissionClient({origin:'https://native.invalid',secret,fetcher:async(_u,o)=>{const v=mutate(response(o!.body as string));return typeof v==='string'?new Response(v):Response.json(v);}});
  await assert.rejects(call(input));
 }
});
test('permission rejects browser-selected authority and unsafe configured origins before any fetch',async()=>{
 for(const origin of ['https://user:pass@native.invalid','https://native.invalid/path','https://native.invalid?x=1'])assert.throws(()=>createInsightPermissionClient({origin,secret}));
 let calls=0;const call=createInsightPermissionClient({origin:'https://native.invalid',secret,fetcher:async()=>{calls++;return Response.json({});}});
 for(const v of [{...input,native_actor_id:'9223372036854775808'},{...input,native_actor_email:'Upper@example.invalid'},{...input,assigned:true}])await assert.rejects(call(v as InsightPermissionInput));
 assert.equal(calls,0);
});
test('fresh access port uses only database native identity and refuses missing or ambiguous contacts',async()=>{
 let rows:any[]=[{native_actor_id:'4',native_actor_email:input.native_actor_email,contact_id:'2'}],queries=0,calls=0;
 const db={query:async(sql:string,values:unknown[])=>{queries++;assert.ok(sql.includes("m.status='active'")&&sql.includes('NOT EXISTS'));assert.deepEqual(values,['fixture','1','aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa','agent','bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb','3']);return {rows};}};
 const access=createInsightAccessPort(db as any,{origin:'https://native.invalid',secret,fetcher:async(_u,o)=>{calls++;assert.deepEqual(JSON.parse(o!.body as string),input);return Response.json(response(o!.body as string));}});
 const actor={tenantId:'fixture',accountId:'1',userId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',role:'agent' as const,impersonated:false};
 const event={tenantId:'fixture',accountId:'1',customerId:'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',conversationId:'3'};
 assert.deepEqual(await access(actor,event),{assigned:true});rows=[];await assert.rejects(access(actor,event));rows=[{},{}];await assert.rejects(access(actor,event));
 await assert.rejects(access({...actor,impersonated:true},event));assert.equal(queries,3);assert.equal(calls,1);
});
test('public insight projection never exposes native evidence IDs or model metadata',()=>{
 const value={revision:1,suppressed:false,long_term:[{text:'关心配送',evidence_ids:['private-native-id']}],current_issue:{text:'询问发货',evidence_ids:['private-native-id']},topic:'shipping'};
 assert.deepEqual(publicInsightProjection(value,true),{can_edit:true,profile:{revision:1,suppressed:false,long_term:['关心配送'],current_issue:'询问发货'}});
 assert.deepEqual(publicInsightProjection(null,false),{profile:null,can_edit:false});
});
