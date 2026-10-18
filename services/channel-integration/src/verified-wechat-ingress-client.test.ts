import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {createVerifiedWeChatIngressClient,type VerifiedWeChatIngress} from './verified-wechat-ingress-client.js';
const secret='isolated-ingress-key-000000000000000000';
const input:VerifiedWeChatIngress={commandId:randomUUID(),accountId:'1',inboxId:'7',connectionId:randomUUID(),appId:'wx0123456789abcdef',
 openId:'isolated-open',sourceEventId:'verified-001',externalMessageId:'001',sourceOccurredAt:'2026-10-02T00:00:00.000Z',content:'多久发货？'};
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
function reply(i=input){
 const binding={account_id:i.accountId,inbox_id:i.inboxId,connection_id:i.connectionId,app_id:i.appId,open_id:i.openId,
  source_event_id:i.sourceEventId,external_message_id:i.externalMessageId,source_occurred_at:i.sourceOccurredAt,content:i.content};
 return {state:'accepted',command_id:i.commandId,account_id:i.accountId,inbox_id:i.inboxId,contact_id:'9',conversation_id:'10',
  message_id:'9007199254740993',source_id:'isolated-source',source_event_id:i.sourceEventId,content_sha256:digest(i.content),binding_sha256:digest(JSON.stringify(binding))};
}
const options={origin:'http://isolated-native.test',secret,enabled:()=>true};
test('可信微信入站默认关闭，无网络调用',async()=>{
 let calls=0;const client=createVerifiedWeChatIngressClient({...options,enabled:undefined,fetcher:async()=>{calls++;return Response.json(reply());}});
 assert.deepEqual(await client.project(input),{outcome:'rejected'});assert.equal(calls,0);
});
test('可信微信入站签名绑定路径及正文，保留大整数编号',async()=>{
 let calls=0;const client=createVerifiedWeChatIngressClient({...options,fetcher:async(url,init)=>{
  assert.equal(String(url),options.origin+'/internal/saas_sso/verified_wechat/ingress');assert.equal(init?.redirect,'error');
  const h=new Headers(init?.headers);assert.equal(h.get('api_access_token'),null);
  assert.equal(h.get('x-automatic-signature'),createHmac('sha256',secret).update(`/internal/saas_sso/verified_wechat/ingress\n${h.get('x-automatic-timestamp')}\n${h.get('x-automatic-nonce')}\n${init?.body}`).digest('hex'));
  assert.equal(JSON.parse(String(init?.body)).open_id,input.openId);calls++;return Response.json(reply());
 }});
 assert.deepEqual(await client.project(input),{outcome:'accepted',accountId:'1',inboxId:'7',contactId:'9',conversationId:'10',messageId:'9007199254740993',sourceId:'isolated-source'});
 assert.equal(calls,1);
});
test('可信微信入站不接受地址、摘要、来源或额外字段不匹配的回执',async()=>{
 for(const body of [null,{},...['account_id','inbox_id','command_id','source_event_id','content_sha256','binding_sha256'].map(k=>({...reply(),[k]:'wrong'})),
  {...reply(),message_id:9007199254740993},{...reply(),source_id:''},{...reply(),extra:true}]){
  const client=createVerifiedWeChatIngressClient({...options,fetcher:async()=>Response.json(body)});
  assert.deepEqual(await client.project(input),{outcome:'uncertain'});
 }
});
test('可信微信入站拒绝非法输入，不回退公共接口',async()=>{
 let calls=0;const client=createVerifiedWeChatIngressClient({...options,fetcher:async()=>{calls++;return Response.json(reply());}});
 for(const i of [{...input,accountId:'0'},{...input,connectionId:'bad'},{...input,appId:'bad'},
  {...input,sourceOccurredAt:'2026-02-30T00:00:00.000Z'},{...input,content:'\ud800'},{...input,content:'x'.repeat(4001)},{...input,externalMessageId:'x'.repeat(129)}]){
  assert.deepEqual(await client.project(i),{outcome:'rejected'});
 }
 assert.equal(calls,0);
 for(const origin of ['file:///tmp','http://user:pass@host','http://host/path','http://host?token=x'])assert.throws(()=>createVerifiedWeChatIngressClient({...options,origin}));
});
test('可信微信入站回执丢失或响应过大仅标记不确定，不内部重试',async()=>{
 for(const fetcher of [async()=>{throw Error('lost_ack');},async()=>new Response('x'.repeat(16385)),async()=>Response.json(reply(),{status:502})]){
  let calls=0;const client=createVerifiedWeChatIngressClient({...options,fetcher:async()=>{calls++;return fetcher();}});
  assert.deepEqual(await client.project(input),{outcome:'uncertain'});assert.equal(calls,1);
 }
});
test('可信微信入站复制请求，调用者等待时修改不改变回执绑定',async()=>{
 const mutable={...input};const client=createVerifiedWeChatIngressClient({...options,fetcher:async()=>{mutable.openId='another';mutable.content='changed';return Response.json(reply());}});
 assert.equal((await client.project(mutable)).outcome,'accepted');
});
test('可信微信入站区分确定拒绝和异常状态',async()=>{
 for(const [status,body,expected] of [[200,{state:'binding_conflict',command_id:input.commandId},'rejected'],
  [401,{error:'unauthorized'},'rejected'],[422,{error:'invalid_payload'},'rejected'],[503,{error:'disabled'},'uncertain'],[200,{state:'accepted'},'uncertain']] as const){
  const client=createVerifiedWeChatIngressClient({...options,fetcher:async()=>Response.json(body,{status})});
  assert.deepEqual(await client.project(input),{outcome:expected});
 }
});
