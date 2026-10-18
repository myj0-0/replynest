import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {createAutomaticWeChatNativeClient,type AutomaticWeChatNativeTarget} from './automatic-wechat-native-client.js';
const now=Date.parse('2026-10-02T01:00:00.000Z'),secret='isolated-wechat-native-key-0000000000000000';
const target:AutomaticWeChatNativeTarget={accountId:'1',customerId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',conversationId:'10',inboxId:'5',contactId:'7',provider:'wechat_official_account',
 authorizationAt:new Date(now-60000).toISOString(),contactIdentifier:'00000000-0000-4000-8000-000000000001:isolated-open-id',sourceEventId:'verified-event-1',sourceOccurredAt:new Date(now-1000).toISOString()};
const question='多久发货？',content='通常两个工作日内发货。',message='100',command=randomUUID();
const hash=(v:string)=>createHash('sha256').update(v,'utf8').digest('hex');
const payload={account_id:'1',conversation_id:'10',inbox_id:'5',contact_id:'7',message_id:message,authorization_at:target.authorizationAt,customer_id:target.customerId,
 provider:target.provider,contact_identifier:target.contactIdentifier,source_event_id:target.sourceEventId,source_occurred_at:target.sourceOccurredAt};
const fence={revision:'9007199254740993',customer_pause_revision:'0',conversation_updated_at:'2026-10-02T00:59:59.123456Z',message_updated_at:'2026-10-02T00:59:59.123456Z',question_sha256:hash(question)};
const echo={account_id:'1',conversation_id:'10',inbox_id:'5',contact_id:'7',source_message_id:message};
const ready={state:'ready',...echo,question,fence};
const permission={state:'transport_authorized',command_id:command,...echo,provider:target.provider,content_sha256:hash(content),
 binding_sha256:hash(JSON.stringify(payload)),expires_at:new Date(now+4000).toISOString()};
const options={origin:'http://isolated-native.test',secret,now:()=>now};
test('snapshot HMAC binds path, nonce, exact verified metadata, without provider/public credentials',async()=>{
 let calls=0;const client=createAutomaticWeChatNativeClient({...options,fetcher:async(url,init)=>{
  assert.equal(String(url),'http://isolated-native.test/internal/saas_sso/automatic_wechat/snapshot');assert.equal(init?.redirect,'error');
  const headers=new Headers(init?.headers),nonce=headers.get('x-automatic-nonce')!;
  assert.match(nonce,/^[a-f0-9]{32}$/);assert.equal(headers.get('api_access_token'),null);
  assert.equal(headers.get('x-automatic-signature'),createHmac('sha256',secret).update(`/internal/saas_sso/automatic_wechat/snapshot\n${now}\n${nonce}\n${init?.body}`).digest('hex'));
  assert.deepEqual(JSON.parse(String(init?.body)),payload);calls++;return Response.json(ready);
 }});
 const r=await client.snapshot(target,message);assert.equal(r.question,question);assert.equal(r.fence?.revision,fence.revision);assert.equal(calls,1);
});
test('authorizes only exact target/provider/wire digest and a short-lived native permission, not delivery',async()=>{
 let calls=0;const client=createAutomaticWeChatNativeClient({...options,fetcher:async(url,init)=>{
  assert.equal(String(url),'http://isolated-native.test/internal/saas_sso/automatic_wechat/authorize');
  assert.deepEqual(JSON.parse(String(init?.body)),{...payload,command_id:command,content,fence});calls++;return Response.json(permission);
 }});
 const r=await client.authorize(target,message,command,content,fence);assert.deepEqual(r,{outcome:'authorized',expiresAt:permission.expires_at});
 assert.ok(Object.isFrozen(r));assert.equal(calls,1);assert.ok(!('receipt' in r));
});
test('expired/excessively future permits are rejected rather than renewed',async()=>{
 for(const expires_at of [new Date(now-1).toISOString(),new Date(now).toISOString(),new Date(now+5001).toISOString()]){
  let calls=0;const client=createAutomaticWeChatNativeClient({...options,fetcher:async()=>{calls++;return Response.json({...permission,expires_at});}});
  assert.deepEqual(await client.authorize(target,message,command,content,fence),{outcome:'rejected'});assert.equal(calls,1);
 }
});
test('foreign command/target/provider/content/binding and old public-send receipts remain uncertain',async()=>{
 for(const body of [null,{},...Object.keys(echo).map(k=>({...permission,[k]:'999'})),
  {...permission,command_id:randomUUID()},{...permission,provider:'shared_wechat'},
  {...permission,content_sha256:hash('other')},{...permission,binding_sha256:hash('other')},
  {...permission,expires_at:100},{...permission,extra:true},{...permission,state:'accepted',message_id:'101'}]){
  let calls=0;const client=createAutomaticWeChatNativeClient({...options,fetcher:async()=>{calls++;return Response.json(body);}});
  assert.deepEqual(await client.authorize(target,message,command,content,fence),{outcome:'uncertain'});assert.equal(calls,1);
 }
});
test('native rejections are definite; conflicts, proxy/server errors and replay never permit send',async()=>{
 for(const [status,body,expected] of [[200,{state:'rejected',command_id:command},'rejected'],[200,{state:'state_changed',command_id:command},'rejected'],
  [401,{error:'unauthorized'},'rejected'],[422,{error:'invalid_payload'},'rejected'],[503,{error:'disabled'},'uncertain'],
  [409,{error:'replay'},'uncertain'],[200,{state:'command_conflict',command_id:command},'uncertain'],[202,permission,'uncertain']] as const){
  const client=createAutomaticWeChatNativeClient({...options,fetcher:async()=>Response.json(body,{status})});
  assert.deepEqual(await client.authorize(target,message,command,content,fence),{outcome:expected});
 }
});
test('snapshot and authorization bind the copied request even when caller mutates target during await',async()=>{
 const t={...target};const client=createAutomaticWeChatNativeClient({...options,fetcher:async()=>{t.contactId='999';return Response.json(ready);}});
 assert.equal((await client.snapshot(t,message)).current,true);
 const t2={...target};const submit=createAutomaticWeChatNativeClient({...options,fetcher:async()=>{t2.provider='shared_wechat';t2.contactIdentifier='other';return Response.json(permission);}});
 assert.equal((await submit.authorize(t2,message,command,content,fence)).outcome,'authorized');
});
test('invalid targets/configuration/content stop before HTTP, without origin fallback',async()=>{
 for(const origin of ['bad','https://user:pass@native.test','https://native.test/path','https://native.test?token=x','file:///foo']){
  assert.throws(()=>createAutomaticWeChatNativeClient({...options,origin}),/^Error: invalid_automatic_wechat_native_config$/);
 }
 for(const key of ['',secret+'\0','x'.repeat(65537)])assert.throws(()=>createAutomaticWeChatNativeClient({...options,secret:key}));
 let calls=0;const client=createAutomaticWeChatNativeClient({...options,fetcher:async()=>{calls++;return Response.json(permission);}});
 for(const t of [{...target,accountId:'9223372036854775808'},{...target,provider:'web_chat'},
  {...target,provider:'shared_wechat',contactIdentifier:'ordinary-id'},{...target,sourceEventId:''},{...target,sourceOccurredAt:'bad'}]){
  await assert.rejects(()=>client.snapshot(t as AutomaticWeChatNativeTarget,message),/^Error: automatic_wechat_native_snapshot_unavailable$/);
  assert.deepEqual(await client.authorize(t as AutomaticWeChatNativeTarget,message,command,content,fence),{outcome:'uncertain'});
 }
 for(const text of ['', '中'.repeat(601),'\ud800','\0'])assert.deepEqual(await client.authorize(target,message,command,text,fence),{outcome:'rejected'});
 assert.equal(calls,0);
});
test('malformed/oversized/invalid UTF-8 and lost native acknowledgement never leak private errors',async()=>{
 for(const fetcher of [async()=>new Response('PRIVATE'),async()=>new Response(new Uint8Array([0xff])),
  async()=>Response.json({content:'x'.repeat(129*1024)}),async()=>{throw Error('PRIVATE_SECRET_URL');}]){
  const client=createAutomaticWeChatNativeClient({...options,fetcher});
  await assert.rejects(()=>client.snapshot(target,message),/^Error: automatic_wechat_native_snapshot_unavailable$/);
  assert.deepEqual(await client.authorize(target,message,command,content,fence),{outcome:'uncertain'});
 }
});
test('two-second deadline covers a stalled native response body with no retry',async()=>{
 let calls=0,signal:AbortSignal|undefined;const client=createAutomaticWeChatNativeClient({...options,fetcher:async(_url,init)=>{
  calls++;signal=init!.signal!;return new Response(new ReadableStream({start(){}}));
 }});
 assert.deepEqual(await client.authorize(target,message,command,content,fence),{outcome:'uncertain'});assert.equal(signal?.aborted,true);assert.equal(calls,1);
});
