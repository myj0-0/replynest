import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {createAutomaticNativeClient,parseAutomaticNativeSnapshot} from './automatic-web-native-client.js';
import type {AutomaticWebTarget} from './automatic-web-chat.js';
const secret='isolated-native-client-key-000000000000',now=new Date('2026-10-01T03:00:00Z');
const t:AutomaticWebTarget={tenantId:'a',accountId:'1',conversationId:'10',inboxId:'5',contactId:'7',customerId:randomUUID(),connectionId:randomUUID(),authorizationAt:now.toISOString()};
const question='多久发货？',content='通常在两个工作日内发货。',command=randomUUID();
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const echo={account_id:'1',conversation_id:'10',inbox_id:'5',contact_id:'7',source_message_id:'100'};
const fence={revision:'9007199254740993',customer_pause_revision:'0',conversation_updated_at:'2026-10-01T03:00:00.123456Z',message_updated_at:'2026-10-01T03:00:00.123456Z',question_sha256:hash(question)};
const ready={state:'ready',...echo,question,fence};
const ack={state:'accepted',...echo,command_id:command,message_id:'101',content_sha256:hash(content)};
const options={origin:'http://engine.test',secret,now:()=>now};
test('native snapshot binds all target fields and preserves large revision/microsecond fence',()=>{
 const s=parseAutomaticNativeSnapshot(ready,t,'100');assert.equal(s.current,true);assert.equal(s.fence?.revision,'9007199254740993');
 assert.ok(Object.isFrozen(s.fence));assert.equal(s.question,question);
 assert.equal(parseAutomaticNativeSnapshot({state:'rejected'},t,'100').current,false);
});
test('native snapshot rejects foreign/missing/extra fields, fake hashes and malformed fences',()=>{
 for(const key of Object.keys(echo))assert.throws(()=>parseAutomaticNativeSnapshot({...ready,[key]:'2'},t,'100'));
 for(const f of [{...fence,revision:1},{...fence,revision:'9223372036854775808'},{...fence,revision:'-1'},
  {...fence,conversation_updated_at:'not-a-date'},{...fence,question_sha256:'0'.repeat(64)},{...fence,extra:true}])assert.throws(()=>parseAutomaticNativeSnapshot({...ready,fence:f},t,'100'));
 for(const r of [{...ready,question:''},{...ready,question:'x'.repeat(4001)},{...ready,extra:true},{state:'ready'},null])assert.throws(()=>parseAutomaticNativeSnapshot(r,t,'100'));
});
test('HMAC includes native path, fresh nonce, millisecond time and exact UTF-8 body; no API token',async()=>{
 const nonces=new Set<string>();let calls=0;
 const client=createAutomaticNativeClient({...options,fetcher:async(url,init)=>{
  assert.equal(String(url),'http://engine.test/internal/saas_sso/automatic_replies/snapshot');
  assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');assert.ok(init?.signal);
  const h=new Headers(init?.headers),nonce=h.get('x-automatic-nonce')!;assert.match(nonce,/^[a-f0-9]{32}$/);assert.ok(!nonces.has(nonce));nonces.add(nonce);
  assert.equal(h.get('api_access_token'),null);assert.equal(h.get('x-automatic-timestamp'),String(now.getTime()));
  assert.equal(h.get('x-automatic-signature'),createHmac('sha256',secret).update(`/internal/saas_sso/automatic_replies/snapshot\n${now.getTime()}\n${nonce}\n${init?.body}`).digest('hex'));
  assert.deepEqual(JSON.parse(String(init?.body)),{account_id:'1',conversation_id:'10',inbox_id:'5',contact_id:'7',message_id:'100',authorization_at:t.authorizationAt,customer_id:t.customerId});
  calls++;return Response.json(ready);
 }});await client.snapshot(t,'100');await client.snapshot(t,'100');assert.equal(calls,2);
});
test('submit uses frozen fence and accepts only native bound content-hash receipt',async()=>{
 let calls=0;const c=createAutomaticNativeClient({...options,fetcher:async(url,init)=>{
  assert.equal(String(url),'http://engine.test/internal/saas_sso/automatic_replies/submit');
  const body=JSON.parse(String(init?.body));assert.deepEqual(body.fence,fence);assert.equal(body.content,content);assert.equal(body.command_id,command);assert.equal(body.show_ai_label,false);
  calls++;return Response.json(ack);
 }});assert.equal((await c.submit(t,'100',command,content,fence)).outcome,'accepted');assert.equal(calls,1);
});
test('visitor label can be explicitly enabled and invalid non-boolean policy never reaches native HTTP',async()=>{
 let calls=0;const c=createAutomaticNativeClient({origin:'http://native.local',secret,now:()=>now,fetcher:async(_url,init)=>{
  calls++;assert.equal(JSON.parse(String(init?.body)).show_ai_label,true);return Response.json(ack);
 }});
 assert.equal((await c.submit(t,'100',command,content,fence,true)).outcome,'accepted');
 assert.equal((await c.submit(t,'100',command,content,fence,'false' as never)).outcome,'rejected');assert.equal(calls,1);
});

test('native changed/rejected are definite; conflict and wrong/legacy receipts remain uncertain',async()=>{
 for(const body of [{state:'rejected',command_id:command},{state:'state_changed',command_id:command}]){
  const c=createAutomaticNativeClient({...options,fetcher:async()=>Response.json(body)});assert.equal((await c.submit(t,'100',command,content,fence)).outcome,'rejected');
 }
 for(const body of [{state:'command_conflict',command_id:command},...Object.keys(echo).map(k=>({...ack,[k]:'999'})),
  {...ack,command_id:randomUUID()},{...ack,content_sha256:'0'.repeat(64)},{...ack,message_id:101},{...ack,extra:true},
  {id:101,account_id:1,conversation_id:10,private:false,message_type:1,content_type:'text',content}]){
  let calls=0;const c=createAutomaticNativeClient({...options,fetcher:async()=>{calls++;return Response.json(body);}});
  assert.equal((await c.submit(t,'100',command,content,fence)).outcome,'uncertain');assert.equal(calls,1);
 }
});
test('only structured pre-action errors are definite HTTP rejection; no HTTP retry/fallback',async()=>{
 for(const [status,body,expected] of [[401,{error:'unauthorized'},'rejected'],[422,{error:'invalid_payload'},'rejected'],
  [403,{error:'arbitrary'},'uncertain'],[409,{error:'replay'},'uncertain'],[503,{error:'native_state_uncertain'},'uncertain'],[500,{},'uncertain'],[302,{},'uncertain']] as const){
  let calls=0;const c=createAutomaticNativeClient({...options,fetcher:async()=>{calls++;return Response.json(body,{status});}});
  assert.equal((await c.submit(t,'100',command,content,fence)).outcome,expected);assert.equal(calls,1);
 }
});
test('oversized, invalid UTF-8/JSON, timeout and lost acknowledgement do not leak upstream errors',async()=>{
 let timeouts=0;
 for(const fetcher of [async()=>new Response('private detail'),async()=>Response.json({data:'x'.repeat(130*1024)}),
  async()=>new Response(new Uint8Array([0xff])),async()=>{throw Error('SECRET private upstream body');},
  async(_url:Parameters<typeof fetch>[0],init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
   const waiting=setTimeout(()=>reject(Error('timeout guard did not abort')),3000);
   init!.signal!.addEventListener('abort',()=>{clearTimeout(waiting);timeouts++;reject(Error('private timeout detail'));},{once:true});
  })]){
  const c=createAutomaticNativeClient({...options,fetcher});
  await assert.rejects(()=>c.snapshot(t,'100'),/^Error: automatic_native_snapshot_unavailable$/);
  assert.equal((await c.submit(t,'100',command,content,fence)).outcome,'uncertain');
 }
 assert.equal(timeouts,2,'snapshot and submit each obey the two-second abort signal');
});
test('invalid origin/secret/target does not send an HTTP request',async()=>{
 for(const origin of ['invalid','https://u:p@engine.test','https://engine.test/path','https://engine.test/#secret','file:///tmp/foo'])assert.throws(()=>createAutomaticNativeClient({...options,origin}),/^Error: invalid_automatic_web_config$/);
 for(const key of ['',secret+'\0','x'.repeat(65537)])assert.throws(()=>createAutomaticNativeClient({...options,secret:key}),/invalid_automatic_web_config/);
 let calls=0;const c=createAutomaticNativeClient({...options,fetcher:async()=>{calls++;return Response.json(ready);}});
 await assert.rejects(()=>c.snapshot({...t,contactId:'9223372036854775808'},'100'),/snapshot_unavailable/);
 assert.equal((await c.submit(t,'100','not-uuid',content,fence)).outcome,'rejected');assert.equal(calls,0);
});
test('sender inspect/prepare bind account and operation to signed internal path, without API token',async()=>{
 const operations:string[]=[],nonces=new Set<string>();
 const c=createAutomaticNativeClient({...options,fetcher:async(url,init)=>{
  assert.equal(String(url),'http://engine.test/internal/saas_sso/automatic_replies/actor');
  const body=JSON.parse(String(init?.body)),h=new Headers(init?.headers),nonce=h.get('x-automatic-nonce')!;
  assert.deepEqual(Object.keys(body).sort(),['account_id','operation']);assert.equal(body.account_id,'1');
  assert.ok(!nonces.has(nonce));nonces.add(nonce);operations.push(body.operation);
  assert.equal(h.get('api_access_token'),null);assert.equal(init?.redirect,'error');assert.ok(init?.signal);
  assert.equal(h.get('x-automatic-signature'),createHmac('sha256',secret).update(`/internal/saas_sso/automatic_replies/actor\n${now.getTime()}\n${nonce}\n${init?.body}`).digest('hex'));
  return Response.json({state:body.operation==='inspect'?'missing':'ready',account_id:'1'});
 }});
 assert.equal(await c.sender.inspect('1'),'missing');assert.equal(await c.sender.prepare('1'),'ready');
 assert.deepEqual(operations,['inspect','prepare']);
});
test('sender readiness fails closed on wrong account, extra fields, unknown state or failed HTTP',async()=>{
 for(const body of [{state:'ready',account_id:'2'},{state:'ready',account_id:1},{state:'ready'},
  {state:'ready',account_id:'1',bot_id:'2'},{state:'accepted',account_id:'1'},null]){
  let calls=0;const c=createAutomaticNativeClient({...options,fetcher:async()=>{calls++;return Response.json(body);}});
  assert.equal(await c.sender.prepare('1'),'unavailable');assert.equal(calls,1);
 }
 for(const state of ['disabled','invalid','missing','ready'] as const){
  const c=createAutomaticNativeClient({...options,fetcher:async()=>Response.json({state,account_id:'1'})});
  assert.equal(await c.sender.inspect('1'),state);
 }
 for(const fetcher of [async()=>Response.json({state:'ready',account_id:'1'},{status:503}),
  async()=>new Response('private detail'),async()=>Response.json({data:'x'.repeat(130*1024)}),
  async()=>{throw Error('private credential');}]){
  let calls=0;const c=createAutomaticNativeClient({...options,fetcher:async()=>{calls++;return fetcher();}});
  assert.equal(await c.sender.prepare('1'),'unavailable');assert.equal(calls,1);
 }
});
test('sender invalid account never reaches native server',async()=>{
 let calls=0;const c=createAutomaticNativeClient({...options,fetcher:async()=>{calls++;return Response.json({state:'ready',account_id:'1'});}});
 for(const account of ['0','-1','01','1/submit','9223372036854775808'])assert.equal(await c.sender.prepare(account),'unavailable');
 assert.equal(calls,0);
});
