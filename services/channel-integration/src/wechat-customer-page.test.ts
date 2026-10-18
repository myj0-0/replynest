import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConversationPageContext} from './conversation-page-context.js';
test('batch nickname projection scopes verified thread and unexpired profile; no customer rename writes',async()=>{
 const queries:{sql:string;args:unknown[]}[]=[];
 const db={query:async(sql:string,args:unknown[])=>{
  queries.push({sql,args});
  if(sql.includes('SELECT chatwoot_resource_id'))return {rows:[{chatwoot_resource_id:'3',replynest_resource_id:'uuid-conversation'}]};
  if(sql.includes('SELECT DISTINCT ON'))return {rows:[{upstream_id:'3',customer_id:'uuid-customer',name:'微信访客',channel:'shared_wechat',wechat_open_id:'oSynthetic1234',nickname:'授权小王',avatar_url:'https://thirdwx.qlogo.cn/synthetic/0'}]};
  return {rows:[]};
 }};
 const result=await loadConversationPageContext(db as never,'tenant_a','2',[{id:3,account_id:2}],async()=>{assert.fail('known contact must not trigger sync');},true,true);
 assert.equal(result.contacts.get('3')?.display_name,'授权小王');
 assert.equal(result.contacts.get('3')?.avatar_url,'https://thirdwx.qlogo.cn/synthetic/0');
 const read=queries.find(v=>v.sql.includes('SELECT DISTINCT ON'))!;
 assert.deepEqual(read.args,['tenant_a',['3']]);assert.match(read.sql,/b\.tenant_id=i\.tenant_id/);assert.match(read.sql,/b\.contact_id=i\.chatwoot_contact_id/);
 assert.match(read.sql,/p\.expires_at>NOW\(\)/);assert.match(read.sql,/p\.avatar_url AS avatar_url/);assert.equal(queries.some(v=>/UPDATE customers|INSERT INTO customers/.test(v.sql)),false);
});

test('authorized avatar projection rejects untrusted URLs, expired/no profile and disabled capability',async()=>{
 for(const [enabled,url,wanted] of [[true,'https://evil.example/a',null],[true,null,null],[false,'https://thirdwx.qlogo.cn/a',null],[true,'https://user:pass@example.com.cn/a',null],[true,'javascript:alert(1)',null],[true,'https://thirdwx.qlogo.cn/a','https://thirdwx.qlogo.cn/a']] as const){
  const db={query:async(sql:string)=>({rows:sql.includes('SELECT chatwoot_resource_id')?[{chatwoot_resource_id:'3',replynest_resource_id:'uuid'}]:sql.includes('SELECT DISTINCT ON')?[{upstream_id:'3',customer_id:'uuid',name:'👦',channel:'shared_wechat',wechat_open_id:'verified1234',avatar_url:url}]:[]})};
  const result=await loadConversationPageContext(db as never,'a','2',[{id:3,account_id:2}],async()=>{},true,enabled);
  assert.equal(result.contacts.get('3')?.display_name,'👦');assert.equal(result.contacts.get('3')?.avatar_url,wanted);
 }
});
test('disabled shared schema is not queried and wrong account is rejected before I/O',async()=>{
 let calls=0;const sqls:string[]=[];
 const db={query:async(sql:string)=>{calls++;sqls.push(sql);return {rows:sql.includes('SELECT chatwoot_resource_id')?[{chatwoot_resource_id:'3',replynest_resource_id:'uuid'}]:sql.includes('SELECT DISTINCT ON')?[{upstream_id:'3',customer_id:'uuid',name:'微信访客',channel:'wechat_official_account',wechat_open_id:'oNative5678'}]:[]};}};
 const result=await loadConversationPageContext(db as never,'a','2',[{id:3,account_id:2}],async()=>{},false,false);
 assert.equal(result.contacts.get('3')?.display_name,'微信访客 · 5678');assert.equal(sqls.some(s=>s.includes('shared_wechat_')),false);
 const before=calls;await assert.rejects(loadConversationPageContext(db as never,'a','2',[{id:3,account_id:9}],async()=>{}));assert.equal(calls,before);
});
