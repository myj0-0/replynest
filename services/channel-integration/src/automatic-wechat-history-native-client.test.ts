import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {createAutomaticWeChatHistoryClient,type AutomaticWeChatHistoryRequest} from './automatic-wechat-history-native-client.js';
const secret='isolated-history-key-0000000000000000',origin='http://isolated-native.invalid';
const request:AutomaticWeChatHistoryRequest={target:{accountId:'1',conversationId:'2',inboxId:'3',contactId:'4',provider:'shared_wechat',
 authorizationAt:'2026-10-02T00:00:00.000Z',sourceOccurredAt:'2026-10-02T00:01:00.000Z',sourceEventId:'verified-event',contactIdentifier:'rn_shared_'+'a'.repeat(64)},
 messageId:'9007199254740993',commandId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',content:'【原商家名称】\n两个工作日内发货。',providerAcceptedAt:'2026-10-02T00:02:00.000Z'};
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
function echo(p:any){return {state:'recorded',command_id:p.command_id,account_id:p.account_id,conversation_id:p.conversation_id,inbox_id:p.inbox_id,
 contact_id:p.contact_id,source_message_id:p.message_id,message_id:'9007199254740994',provider:p.provider,content_sha256:sha(p.content),provider_accepted_at:p.provider_accepted_at};}
test('history RPC is default-off and never calls native or provider',async()=>{
 const c=createAutomaticWeChatHistoryClient({origin,secret,fetcher:async()=>{assert.fail('I/O must stay closed');}});
 assert.deepEqual(await c.project(request),{outcome:'rejected'});
});
test('history signs fixed route and exact accepted body, preserves integer precision without inventing provider ID',async()=>{
 const c=createAutomaticWeChatHistoryClient({origin,secret,enabled:()=>true,fetcher:async(url,init)=>{
  assert.equal(String(url),origin+'/internal/saas_sso/automatic_wechat/history');assert.equal(init?.redirect,'error');
  const p=JSON.parse(init!.body as string),h=init!.headers as Record<string,string>;
  assert.equal(p.content,request.content);assert.equal(p.provider_accepted_at,'2026-10-02T00:02:00.000000Z');
  assert.equal(h['x-automatic-signature'],createHmac('sha256',secret).update(`/internal/saas_sso/automatic_wechat/history\n${h['x-automatic-timestamp']}\n${h['x-automatic-nonce']}\n${init!.body}`).digest('hex'));
  assert.equal('fence' in p,false);assert.equal('access_token' in p,false);
  return Response.json(echo(p));}});
 assert.deepEqual(await c.project(request),{outcome:'recorded',messageId:'9007199254740994'});
});
test('history validates all echoed bindings, hash, time, unknown and duplicate fields',async()=>{
 for(const change of [{account_id:'9'},{conversation_id:'9'},{contact_id:'9'},{inbox_id:'9'},{source_message_id:'9'},{command_id:'other'},
  {content_sha256:'a'.repeat(64)},{provider:'web_chat'},{provider_accepted_at:'2026-10-02T00:02:00.000001Z'},{message_id:9007199254740994},{delivered:true}]){
  const c=createAutomaticWeChatHistoryClient({origin,secret,enabled:()=>true,fetcher:async(_u,i)=>Response.json({...echo(JSON.parse(i!.body as string)),...change})});
  assert.deepEqual(await c.project(request),{outcome:'uncertain'});
 }
 const c=createAutomaticWeChatHistoryClient({origin,secret,enabled:()=>true,fetcher:async(_u,i)=>{
  const p=echo(JSON.parse(i!.body as string));return new Response(JSON.stringify(p).replace('"state":"recorded"','"state":"recorded","st\\u0061te":"recorded"'));}});
 assert.deepEqual(await c.project(request),{outcome:'uncertain'});
});
test('deleted history or conflicting command is terminal rejection; transport/HTTP failures remain uncertain',async()=>{
 for(const state of ['history_missing','command_conflict','rejected']){
  const c=createAutomaticWeChatHistoryClient({origin,secret,enabled:()=>true,fetcher:async()=>Response.json({state,command_id:request.commandId})});
  assert.deepEqual(await c.project(request),{outcome:'rejected'});
 }
 for(const fetcher of [async()=>{throw Error('private content');},async()=>new Response('private error',{status:503}),async()=>new Response('x'.repeat(16385))]){
  const c=createAutomaticWeChatHistoryClient({origin,secret,enabled:()=>true,fetcher});assert.deepEqual(await c.project(request),{outcome:'uncertain'});
 }
});
test('bounded native history deadline does not become a second WeChat request',async()=>{
 let calls=0;const c=createAutomaticWeChatHistoryClient({origin,secret,enabled:()=>true,fetcher:async()=>{calls++;return new Promise<Response>(()=>{});}});
 // Measure an elapsed deadline with a monotonic clock; wall-clock adjustments
 // do not extend the setTimeout deadline or authorize a second request.
 const at=performance.now();assert.deepEqual(await c.project(request),{outcome:'uncertain'});assert.ok(performance.now()-at<2500);assert.equal(calls,1);
});
test('invalid history inputs are refused before HTTP and caller mutation cannot change a captured body',async()=>{
 let calls=0;const c=createAutomaticWeChatHistoryClient({origin,secret,enabled:()=>true,fetcher:async(_u,i)=>{calls++;return Response.json(echo(JSON.parse(i!.body as string)));}});
 for(const r of [{...request,content:' '},{...request,content:'字'.repeat(601)},{...request,providerAcceptedAt:'2026-02-30T00:00:00.000Z'},
  {...request,commandId:'not-uuid'}])assert.deepEqual(await c.project(r),{outcome:'rejected'});
 assert.equal(calls,0);
 const mutable=structuredClone(request);const pending=c.project(mutable);(mutable as any).content='changed';(mutable.target as any).accountId='999';
 assert.equal((await pending).outcome,'recorded');assert.equal(calls,1);
});
