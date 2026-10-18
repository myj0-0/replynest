import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createAutomaticWeChatTransport,type AutomaticWeChatAttempt,type AutomaticWeChatRequest} from './automatic-wechat-transport.js';
const at=Date.parse('2026-10-02T01:00:00.000Z'),appId='wx0123456789abcdef',token='isolated-token';
function input(shared=false):AutomaticWeChatRequest{
 return {lease:{tenantId:'isolated-tenant',jobId:randomUUID(),messageId:'100',accountId:'1',conversationId:'10',
  customerId:randomUUID(),authorizationId:randomUUID(),workerToken:randomUUID(),consentVersion:'automatic-send-v1',
  channel:shared?'shared_wechat':'wechat_official_account',connectionId:shared?null:randomUUID()},
  appId,openId:'isolated-open-id',draftText:'您好，通常两个工作日内发货。',sourceOccurredAt:at,merchantName:shared?'答巢测试商家':undefined};
}
const options={enabled:()=>true,now:()=>at,
 resolveAccessToken:async()=>({appId,accessToken:token}),
 claimAuthorizedAttempt:async(_a:AutomaticWeChatAttempt)=>({outcome:'claimed' as const,expiresAt:at+5000})};
const ok=()=>Response.json({errcode:0,errmsg:'ok'});

test('default closed transport has no credential, claim or network side effects',async()=>{
 const forbidden=async()=>{assert.fail('side effect');};
 const t=createAutomaticWeChatTransport({resolveAccessToken:forbidden,claimAuthorizedAttempt:forbidden,fetcher:forbidden});
 assert.deepEqual(await t.send(input()),{outcome:'rejected',reason:'execution_disabled'});
});
test('independent send uses exact recipient/text and default-off AI marker; acknowledgement has no invented delivery ID',async()=>{
 const r=input();let calls=0;
 const t=createAutomaticWeChatTransport({...options,fetcher:async(url,init)=>{
  const parsed=new URL(String(url));assert.equal(parsed.origin,'https://api.weixin.qq.com');assert.equal(parsed.pathname,'/cgi-bin/message/custom/send');
  assert.equal(parsed.searchParams.get('access_token'),token);assert.equal(init?.redirect,'error');assert.equal(init?.method,'POST');
  assert.ok(init?.signal);assert.deepEqual(JSON.parse(String(init?.body)),{touser:r.openId,msgtype:'text',text:{content:r.draftText},aimsgcontext:{is_ai_msg:0}});
  calls++;return ok();
 }});
 const result=await t.send(r);assert.deepEqual(result,{outcome:'accepted',receipt:{provider:'wechat_official_account',acknowledged:true}});
 assert.ok(result.outcome==='accepted'&&Object.isFrozen(result.receipt));assert.equal(calls,1);
});

test('AI label can be enabled by trusted server options, never by request/model fields',async()=>{
 for(const shared of [false,true])for(const selected of [false,true]){
  const r=input(shared);Object.assign(r,{showAiLabel:!selected,aimsgcontext:{is_ai_msg:!selected?1:0}});
  const deps={...options,showAiLabel:selected,fetcher:async(_url:any,init:any)=>{
   const body=JSON.parse(String(init.body));assert.equal(body.aimsgcontext.is_ai_msg,selected?1:0);
   assert.equal(body.text.content,shared?`【${r.merchantName}】\n${r.draftText}`:r.draftText);return ok();}};
  const transport=createAutomaticWeChatTransport(deps);deps.showAiLabel=!selected;
  assert.equal((await transport.send(r)).outcome,'accepted');
 }
 assert.throws(()=>createAutomaticWeChatTransport({...options,showAiLabel:'false' as never}),/invalid_ai_public_label/);
});
test('shared send includes a merchant prefix; claim binds final UTF-8 wire content digest',async()=>{
 const r=input(true),expected=`【${r.merchantName}】\n${r.draftText}`;
 const t=createAutomaticWeChatTransport({...options,claimAuthorizedAttempt:async a=>{
  assert.equal(a.content,expected);assert.equal(a.contentSha256,createHash('sha256').update(expected).digest('hex'));
  assert.ok(Object.isFrozen(a)&&Object.isFrozen(a.request)&&Object.isFrozen(a.request.lease));return {outcome:'claimed',expiresAt:at+5000};
 },fetcher:async(_url,init)=>{assert.equal(JSON.parse(String(init?.body)).text.content,expected);return ok();}});
 assert.deepEqual(await t.send(r),{outcome:'accepted',receipt:{provider:'shared_wechat',acknowledged:true}});
});
test('invalid channel/tenant/lease/destination never resolves a token or claims/sends',async()=>{
 const r=input(),leaseChanges=[{channel:'web_chat'},{accountId:'01'},{conversationId:'9223372036854775808'},
  {messageId:'1.5'},{tenantId:''},{tenantId:'bad\0'},{jobId:'model-chosen'},{customerId:'other'},
  {authorizationId:''},{workerToken:''},{consentVersion:'automatic-reply-v1'},{connectionId:null},
  {channel:'shared_wechat',connectionId:randomUUID()}];
 const forbidden=async()=>{assert.fail('side effect');};
 const t=createAutomaticWeChatTransport({...options,resolveAccessToken:forbidden,claimAuthorizedAttempt:forbidden,fetcher:forbidden});
 for(const changes of leaseChanges)assert.deepEqual(await t.send({...r,lease:{...r.lease,...changes}} as AutomaticWeChatRequest),{outcome:'rejected',reason:'invalid_target'});
 for(const changes of [{appId:'wxwrong'},{appId:appId+'?secret'},{openId:'u\n'},{openId:'https://elsewhere'},
  {openId:''},{openId:'x'.repeat(129)}])assert.equal((await t.send({...r,...changes})).outcome,'rejected');
});
test('invalid/oversized content is rejected without truncation, credential or send',async()=>{
 const forbidden=async()=>{assert.fail('side effect');};
 const t=createAutomaticWeChatTransport({...options,resolveAccessToken:forbidden,claimAuthorizedAttempt:forbidden,fetcher:forbidden});
 for(const draftText of ['','  ','x\0y','\ud800','中'.repeat(601),'x'.repeat(4001)]){
  assert.deepEqual(await t.send({...input(),draftText}),{outcome:'rejected',reason:'invalid_content'});
 }
 for(const merchantName of [undefined,'','x'.repeat(81),'商家\nB','商家\u202e','【另一家】']){
  assert.deepEqual(await t.send({...input(true),merchantName}),{outcome:'rejected',reason:'invalid_content'});
 }
 assert.equal((await t.send({...input(true),draftText:'中'.repeat(600)})).outcome,'rejected','prefix counts toward byte ceiling');
});
test('exact byte limit and significant whitespace survive unchanged',async()=>{
 const texts=['中'.repeat(600),' '+ 'x'.repeat(1798)+' '];let calls=0;
 const t=createAutomaticWeChatTransport({...options,fetcher:async(_url,init)=>{
  assert.equal(JSON.parse(String(init?.body)).text.content,texts[calls++]);return ok();
 }});
 for(const draftText of texts)assert.equal((await t.send({...input(),draftText})).outcome,'accepted');assert.equal(calls,2);
});
test('future/invalid/stale input and expired provider window do not send',async()=>{
 const forbidden=async()=>{assert.fail('side effect');};
 const t=createAutomaticWeChatTransport({...options,resolveAccessToken:forbidden,claimAuthorizedAttempt:forbidden,fetcher:forbidden});
 for(const sourceOccurredAt of [at+1,NaN,Infinity,-1,at-600001])assert.deepEqual(await t.send({...input(),sourceOccurredAt}),{outcome:'rejected',reason:'source_message_stale'});
 assert.deepEqual(await t.send({...input(),sourceOccurredAt:at-48*3600000}),{outcome:'rejected',reason:'reply_window_expired'});
 const edge=createAutomaticWeChatTransport({...options,fetcher:async()=>ok()});
 assert.equal((await edge.send({...input(),sourceOccurredAt:at-600000})).outcome,'accepted');
});
test('token resolution precedes the final durable claim, with recipient/lease frozen across await',async()=>{
 const r=input(),originalOpen=r.openId,originalJob=r.lease.jobId,events:string[]=[];
 const t=createAutomaticWeChatTransport({...options,resolveAccessToken:async(id,channel,connection)=>{
  events.push('token');assert.equal(id,appId);assert.equal(channel,'wechat_official_account');assert.equal(connection,r.lease.connectionId);
  (r as {openId:string}).openId='tampered';(r.lease as {jobId:string}).jobId=randomUUID();return {appId,accessToken:token};
 },claimAuthorizedAttempt:async a=>{events.push('claim');assert.equal(a.request.openId,originalOpen);assert.equal(a.request.lease.jobId,originalJob);return {outcome:'claimed',expiresAt:at+5000};},
 fetcher:async(_url,init)=>{events.push('send');assert.equal(JSON.parse(String(init?.body)).touser,originalOpen);return ok();}});
 assert.equal((await t.send(r)).outcome,'accepted');assert.deepEqual(events,['token','claim','send']);
});
test('wrong-account/empty/invalid tokens and credential errors stop before durable claim',async()=>{
 for(const resolveAccessToken of [async()=>({appId:'wx1111111111111111',accessToken:token}),
  ...['','bad\n','x'.repeat(4097)].map(accessToken=>async()=>({appId,accessToken})),async()=>{throw Error('PRIVATE_SECRET');}]){
  const t=createAutomaticWeChatTransport({...options,resolveAccessToken,claimAuthorizedAttempt:async()=>{assert.fail('claim');},fetcher:async()=>{assert.fail('send');}});
  const result=await t.send(input());assert.deepEqual(result,{outcome:'rejected',reason:'credentials_unavailable'});assert.ok(!JSON.stringify(result).includes('PRIVATE'));
 }
});
test('revocation or source expiry while resolving credentials is rechecked before claim',async()=>{
 for(const expire of [false,true]){
  let active=true,time=at;const t=createAutomaticWeChatTransport({...options,enabled:()=>active,now:()=>time,
   resolveAccessToken:async()=>{if(expire)time+=600001;else active=false;return {appId,accessToken:token};},
   claimAuthorizedAttempt:async()=>{assert.fail('claim');},fetcher:async()=>{assert.fail('send');}});
  assert.deepEqual(await t.send(input()),{outcome:'rejected',reason:expire?'source_message_stale':'execution_disabled'});
 }
});
test('claimed duplicate, authorization rejection, invalid result and lost claim ack never send',async()=>{
 for(const [claim,expected] of [['rejected','authorization_changed'],['already_attempted','attempt_already_claimed'],['invalid','attempt_unconfirmed']] as const){
  const t=createAutomaticWeChatTransport({...options,claimAuthorizedAttempt:async()=>claim as never,fetcher:async()=>{assert.fail('send');}});
  const result=await t.send(input());assert.equal('reason' in result&&result.reason,expected);assert.equal(result.outcome,claim==='rejected'?'rejected':'uncertain');
 }
 const t=createAutomaticWeChatTransport({...options,claimAuthorizedAttempt:async()=>{throw Error('COMMIT_ACK_SECRET');},fetcher:async()=>{assert.fail('send');}});
 assert.deepEqual(await t.send(input()),{outcome:'uncertain',reason:'attempt_unconfirmed'});
});
test('final revocation/expiry after durable marker never posts or reopens the marker',async()=>{
 for(const expire of [false,true]){
  let active=true,time=at;const t=createAutomaticWeChatTransport({...options,enabled:()=>active,now:()=>time,
   claimAuthorizedAttempt:async()=>{if(expire)time+=600001;else active=false;return {outcome:'claimed',expiresAt:at+5000};},fetcher:async()=>{assert.fail('send');}});
  assert.deepEqual(await t.send(input()),{outcome:'rejected',reason:expire?'authorization_changed':'execution_disabled'});
 }
});

test('only a current bounded native permit may reach the provider; bare legacy claim is insufficient',async()=>{
 for(const claim of ['claimed',{outcome:'claimed',expiresAt:at},{outcome:'claimed',expiresAt:at+5001},
  {outcome:'claimed',expiresAt:NaN},{outcome:'claimed',expiresAt:at+1000,other:true}]){
  const t=createAutomaticWeChatTransport({...options,claimAuthorizedAttempt:async()=>claim as never,fetcher:async()=>{assert.fail('expired or malformed permit sent');}});
  assert.notEqual((await t.send(input())).outcome,'accepted');
 }
});
test('provider window/limit/permission/token rejections preserve only code, never refresh or retry',async()=>{
 for(const [code,reason] of [[45015,'reply_window_expired'],[45009,'provider_rate_limited'],[45011,'provider_rate_limited'],
  [45047,'provider_rate_limited'],[48001,'provider_permission_denied'],[48002,'provider_permission_denied'],[48004,'provider_permission_denied'],
  [40014,'provider_rejected'],[42001,'provider_rejected'],[70000,'provider_rejected']] as const){
  let calls=0,tokens=0;const t=createAutomaticWeChatTransport({...options,resolveAccessToken:async()=>{tokens++;return {appId,accessToken:token};},
   fetcher:async()=>{calls++;return Response.json({errcode:code,errmsg:'PRIVATE_PROVIDER_DETAIL'});}});
  assert.deepEqual(await t.send(input()),{outcome:'rejected',reason,providerCode:code});assert.equal(calls,1);assert.equal(tokens,1);
 }
});
test('ambiguous/negative/malformed acknowledgements stay uncertain with one attempt',async()=>{
 const values=[null,[],{}, {errcode:'0',errmsg:'ok'}, {errcode:0,errmsg:'not ok'}, {errcode:0,errmsg:'ok',delivery:true},
  {errcode:-1,errmsg:'system error'}, {errcode:45009}, {errcode:1.5,errmsg:'error'}, {errcode:9007199254740992,errmsg:'error'}];
 const replies=[...values.map(v=>()=>Response.json(v)),()=>new Response('private proxy body'),()=>new Response('{"errcode":-0,"errmsg":"ok"}'),
  ()=>new Response('{"errcode":45009,"errmsg":"ok","errcode":0}'),
  ()=>new Response('{"errcode":45009,"errmsg":"ok","\\u0065rrcode":0}'),()=>new Response(new Uint8Array([0xff])),
  ()=>Response.json({errcode:0,errmsg:'x'.repeat(8192)}),()=>Response.json({errcode:0,errmsg:'ok'},{status:503}),
  ()=>Response.json({errcode:0,errmsg:'ok'},{status:202}),()=>new Response('redirect',{status:302}),()=>new Response('',{status:204})];
 for(const reply of replies){let calls=0;const t=createAutomaticWeChatTransport({...options,fetcher:async()=>{calls++;return reply();}});
  assert.deepEqual(await t.send(input()),{outcome:'uncertain',reason:'provider_result_uncertain'});assert.equal(calls,1);}
});
test('network/stream failures discard raw URLs and credentials without retry',async()=>{
 for(const fetcher of [async()=>{throw Error(`https://api.weixin.qq.com/?access_token=${token} SECRET`);},
  async()=>new Response(new ReadableStream({start(c){c.error(Error('PRIVATE_STREAM'));}}))]){
  const t=createAutomaticWeChatTransport({...options,fetcher});assert.deepEqual(await t.send(input()),{outcome:'uncertain',reason:'provider_result_uncertain'});
 }
});
test('deadline covers a stalled response body and aborts it without replay',async()=>{
 let calls=0,signal:AbortSignal|undefined;
 const t=createAutomaticWeChatTransport({...options,fetcher:async(_url,init)=>{calls++;signal=init!.signal!;
  return new Response(new ReadableStream({start(){/* Deliberately never close. */}}));}});
 const result=await t.send(input());assert.deepEqual(result,{outcome:'uncertain',reason:'provider_result_uncertain'});
 assert.equal(signal?.aborted,true);assert.equal(calls,1);
});
test('credential deadline aborts a stuck resolver before any authorization or send attempt',async()=>{
 let signal:AbortSignal|undefined;
 const t=createAutomaticWeChatTransport({...options,resolveAccessToken:async(_app,_channel,_connection,abort)=>{
  signal=abort;return new Promise(()=>{});
 },claimAuthorizedAttempt:async()=>{assert.fail('claim');},fetcher:async()=>{assert.fail('send');}});
 assert.deepEqual(await t.send(input()),{outcome:'rejected',reason:'credentials_unavailable'});assert.equal(signal?.aborted,true);
});
test('restarted transport relies on injected durable claim, never process-local deduplication',async()=>{
 // This is a port-contract fake, NOT evidence of real database durability.
 const attempts=new Set<string>();let calls=0;
 const deps={...options,claimAuthorizedAttempt:async(a:AutomaticWeChatAttempt)=>{
  const key=a.request.lease.jobId;if(attempts.has(key))return 'already_attempted' as const;attempts.add(key);return {outcome:'claimed' as const,expiresAt:at+5000};
 },fetcher:async()=>{calls++;throw Error('ack lost');}};
 const r=input();const results=await Promise.all([createAutomaticWeChatTransport(deps).send(r),createAutomaticWeChatTransport(deps).send(r)]);
 assert.ok(results.every(result=>result.outcome==='uncertain'));assert.equal(calls,1);
 assert.deepEqual(await createAutomaticWeChatTransport(deps).send(r),{outcome:'uncertain',reason:'attempt_already_claimed'});assert.equal(calls,1);
});
