import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {createAutomaticWeChatTokenResolver} from './automatic-wechat-credentials.js';
import {AutomaticWeChatCredentialRejected} from './automatic-wechat-transport.js';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
const app='wx0123456789abcdef',secret='a'.repeat(32),grant='66666666-6666-4666-8666-666666666666';
const lease:AutomaticReceptionLease={tenantId:'synthetic',jobId:'11111111-1111-4111-8111-111111111111',
 workerToken:'22222222-2222-4222-8222-222222222222',authorizationId:'33333333-3333-4333-8333-333333333333',
 customerId:'44444444-4444-4444-8444-444444444444',connectionId:'55555555-5555-4555-8555-555555555555',
 accountId:'1',conversationId:'2',messageId:'3',channel:'wechat_official_account',consentVersion:'automatic-send-v1'};
const error=/^Error: automatic_wechat_credentials_unavailable$/;
function fixture(){
 let now=Date.now(),queries=0,reads=0,requests=0;
 const mode={authorized:true,app,secret,reference:'/isolated/credential.json',changed:false};
 const row=()=>({app_id:mode.app,open_id:'isolated-open',contact_id:'9',inbox_id:'7',grant_id:grant,authorization_ms:String(now-30000),
  event_id:'source-3',source_occurred_at:new Date(now-100).toISOString(),question:'合成问题'});
 const db={query:async(sql:string,args:unknown[])=>{
  queries++;
  if(sql.includes('SELECT 1 FROM automatic_reception_jobs'))return {rowCount:args[0]===lease.tenantId&&args[1]===lease.jobId&&args[2]===lease.workerToken?1:0,rows:[]};
  if(sql.includes('SELECT credential_ref'))return {rows:[{credential_ref:mode.reference}]};
  if(sql.includes('SELECT r.app_id,r.open_id FROM'))return {rows:[{app_id:app,open_id:'isolated-open'}]};
  if(sql.includes('routing_state')){
   const digest=createHash('sha256').update(JSON.stringify([app,lease.tenantId,'isolated-open'])).digest('hex');
   return {rows:mode.authorized?[{...row(),source_occurred_at:new Date(now-100),external_user_id:digest,route_version:1,
    merchant_name:'合成商家',database_now:now,routing_state:{appId:app,openId:'isolated-open',lastTransitionAt:now-1000,
     version:1,associations:[{tenantId:lease.tenantId,name:'合成商家'}]}}]:[]};
  }
  return {rows:mode.authorized?[row()]:[]};
 }} as unknown as Pool;
 const opts={enabled:()=>true,now:()=>now,readIndependent:async(reference:string,appId:string)=>{
  reads++;assert.equal(reference,mode.reference);assert.equal(appId,app);return {appId:app,appSecret:mode.secret};},
  readShared:async()=>{reads++;return {appId:mode.app,appSecret:mode.secret};},
  fetcher:async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
   requests++;assert.equal(String(url),'https://api.weixin.qq.com/cgi-bin/stable_token');assert.equal(init?.redirect,'error');
   assert.deepEqual(JSON.parse(String(init?.body)),{grant_type:'client_credential',appid:app,secret:mode.secret,force_refresh:false});
   return Response.json({access_token:'isolated-access-token',expires_in:345});
  }};
 return {db,opts,mode,get now(){return now;},set now(v:number){now=v;},get queries(){return queries;},get reads(){return reads;},get requests(){return requests;}};
}
test('自动凭据解析缺省关闭及已取消请求零数据访问',async()=>{
 const f=fixture(),resolve=createAutomaticWeChatTokenResolver(f.db,{...f.opts,enabled:undefined});
 await assert.rejects(resolve(lease,app,new AbortController().signal),error);
 const c=new AbortController();c.abort();await assert.rejects(createAutomaticWeChatTokenResolver(f.db,f.opts)(lease,app,c.signal),error);
 assert.equal(f.queries,0);assert.equal(f.reads,0);assert.equal(f.requests,0);
});
test('稳定凭据只用普通模式，缓存有界且不超过供应商实际有效期',async()=>{
 const f=fixture(),resolve=createAutomaticWeChatTokenResolver(f.db,f.opts),signal=new AbortController().signal;
 assert.deepEqual(await resolve(lease,app,signal),{appId:app,accessToken:'isolated-access-token'});
 await resolve(lease,app,signal);assert.equal(f.requests,1);assert.equal(f.reads,4);
 f.now+=301000;await resolve(lease,app,signal);assert.equal(f.requests,2);
});
test('缓存命中仍核对租户、任务租约及当前授权，不能借用他人公众号',async()=>{
 const f=fixture(),resolve=createAutomaticWeChatTokenResolver(f.db,f.opts),signal=new AbortController().signal;
 await resolve(lease,app,signal);const reads=f.reads;
 await assert.rejects(resolve({...lease,tenantId:'other'},app,signal),error);
 await assert.rejects(resolve({...lease,workerToken:grant},app,signal),error);
 f.mode.authorized=false;await assert.rejects(resolve(lease,app,signal),error);
 assert.equal(f.requests,1);assert.equal(f.reads,reads);
});
test('密钥轮换不会复用旧缓存，等待期间换授权或路径拒绝返回凭据',async()=>{
 const f=fixture(),resolve=createAutomaticWeChatTokenResolver(f.db,f.opts),signal=new AbortController().signal;
 await resolve(lease,app,signal);f.mode.secret='b'.repeat(32);await resolve(lease,app,signal);assert.equal(f.requests,2);
 for(const mutate of [()=>{f.mode.authorized=false;},()=>{f.mode.reference='/isolated/changed.json';},()=>{f.mode.secret='c'.repeat(32);}]){
  f.mode.authorized=true;f.mode.secret='d'.repeat(32);f.mode.reference='/isolated/credential.json';
  const changed=createAutomaticWeChatTokenResolver(f.db,{...f.opts,fetcher:async()=>{mutate();return Response.json({access_token:'isolated-token',expires_in:7200});}});
  await assert.rejects(changed(lease,app,signal),error);
 }
});
test('共享凭据只读取当前共享账号，不读取独立文件或回退其他账号',async()=>{
 const f=fixture(),shared={...lease,channel:'shared_wechat' as const,connectionId:null},signal=new AbortController().signal;
 const resolve=createAutomaticWeChatTokenResolver(f.db,{...f.opts,readIndependent:async()=>{assert.fail('independent fallback');}});
 assert.equal((await resolve(shared,app,signal)).appId,app);assert.equal(f.requests,1);
 f.mode.app='wx1111111111111111';await assert.rejects(resolve(shared,app,signal),error);assert.equal(f.requests,1);
});
test('异常、歧义、超大响应和错误消息全部脱敏且不重试',async()=>{
 for(const raw of ['{"access_token":"a","access_token":"b","expires_in":7200}',
  '{"access_token":"a","\\u0061ccess_token":"b","expires_in":7200}',
  JSON.stringify({access_token:'ok',expires_in:7200,errcode:0}),JSON.stringify({errcode:-1,errmsg:'private-secret-path'}),
  JSON.stringify({access_token:'a'.repeat(4097),expires_in:7200}),JSON.stringify({access_token:'token\n',expires_in:7200}),
  ...[0,30,7201,1.5,'7200'].map(expires_in=>JSON.stringify({access_token:'token',expires_in})), ' '.repeat(8193),'not json']){
  const f=fixture();let calls=0;
  const resolve=createAutomaticWeChatTokenResolver(f.db,{...f.opts,fetcher:async()=>{calls++;return new Response(raw);}});
  await assert.rejects(resolve(lease,app,new AbortController().signal),error);assert.equal(calls,1);
 }
 const f=fixture(),resolve=createAutomaticWeChatTokenResolver(f.db,{...f.opts,readIndependent:async()=>{throw Error('private /secret/path');}});
 await assert.rejects(resolve(lease,app,new AbortController().signal),error);assert.equal(f.requests,0);
});
test('凭据接口明确拒绝只保留数字码，不输出原始errmsg或重试',async()=>{
 for(const code of [45009,45011,40164,40125]){
  const f=fixture();let calls=0;
  const resolve=createAutomaticWeChatTokenResolver(f.db,{...f.opts,fetcher:async()=>{calls++;return Response.json({errcode:code,errmsg:'private key and IP'});}});
  await assert.rejects(resolve(lease,app,new AbortController().signal),e=>e instanceof AutomaticWeChatCredentialRejected&&
   e.providerCode===code&&e.message==='automatic_wechat_credentials_rejected'&&!('errmsg' in e));
  assert.equal(calls,1);
 }
});
test('中途取消能中断不配合的响应体，不缓存或返回迟到凭据',async()=>{
 const f=fixture(),c=new AbortController();let cancelled=0;
 const resolve=createAutomaticWeChatTokenResolver(f.db,{...f.opts,fetcher:async()=>new Response(new ReadableStream({cancel(){cancelled++;}}))});
 const result=resolve(lease,app,c.signal);setTimeout(()=>c.abort(),20);await assert.rejects(result,error);assert.equal(cancelled,1);
});
test('解析超时有七秒绝对上限，迟到文件结果不能触发接口请求',async()=>{
 const f=fixture();let complete!:(value:{appId:string;appSecret:string})=>void;
 const read=new Promise<{appId:string;appSecret:string}>(r=>{complete=r;});
 const resolve=createAutomaticWeChatTokenResolver(f.db,{...f.opts,readIndependent:()=>read});
 await assert.rejects(resolve(lease,app,new AbortController().signal),error);complete({appId:app,appSecret:secret});
 await new Promise<void>(r=>setImmediate(r));assert.equal(f.requests,0);
});
test('凭据缓存最多保存128个账号键，淘汰后重新请求，不无限累积',async()=>{
 const f=fixture();let requests=0;
 const resolve=createAutomaticWeChatTokenResolver(f.db,{...f.opts,
  readIndependent:async(_reference,appId)=>({appId,appSecret:secret}),
  fetcher:async()=>{requests++;return Response.json({access_token:'isolated-token',expires_in:7200});}});
 const signal=new AbortController().signal,first='wx0000000000000000';
 for(let i=0;i<129;i++){f.mode.app='wx'+i.toString(16).padStart(16,'0');await resolve(lease,f.mode.app,signal);}
 assert.equal(requests,129);f.mode.app=first;await resolve(lease,first,signal);assert.equal(requests,130);
});
