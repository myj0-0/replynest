import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthorizedReceptionHistoryReader,redactReceptionHistoryText,type AuthorizedHistoryScope} from './reception-history-reader.js';
const asOf='2026-10-06T00:00:00.000000Z',now=Date.parse(asOf);
const scope:AuthorizedHistoryScope={tenantId:'a',accountId:'2',purpose:'context',grantId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',customerId:'bbbbbbbb-1111-4111-8111-aaaaaaaaaaaa'};
const row=(message='1',text='Synthetic question',extra:Record<string,unknown>={})=>({account_id:'2',contact_id:'41',inbox_id:'3',conversation_id:'4',message_id:message,created_at:new Date(now-Number(message)*1000).toISOString(),direction:'incoming' as const,author_kind:'customer' as const,text,...extra});
function fixture(){
 const state={approved:true,connections:0,queries:[] as string[],contacts:['41'],customer:{name:'Synthetic Name',phone:'13800138000',email:'synthetic@example.invalid'},grantChecks:0};
 const db={connect:async()=>{state.connections++;return {release(){state.connections--;},query:async(sql:string)=>{
  state.queries.push(sql);
  if(sql.startsWith('SELECT 1 FROM reception_history_grants')){state.grantChecks++;return {rows:state.approved?[{v:1}]:[],rowCount:state.approved?1:0};}
  if(sql.startsWith('SELECT to_char'))return {rows:[{as_of:asOf}]};
  if(sql.startsWith('SELECT name'))return {rows:[state.customer]};
  if(sql.startsWith('SELECT DISTINCT'))return {rows:state.contacts.map(id=>({id}))};
  return {rows:[]};
 }};}};
 return {state,db:db as any};
}
test('default-off reader never accesses database/native; invalid caller fields fail before I/O',async()=>{
 const f=fixture(),native={page:async()=>assert.fail('no native')};
 await assert.rejects(()=>createAuthorizedReceptionHistoryReader(f.db,native).read(scope),/history_read_disabled/);assert.equal(f.state.queries.length,0);
 const reader=createAuthorizedReceptionHistoryReader(f.db,native,{enabled:()=>true});
 for(const change of [{tenantId:'other;SQL'}, {accountId:'0'},{customerId:undefined},{approved:true},{purpose:'all'},{grantId:'old-v3'}])await assert.rejects(()=>reader.read({...scope,...change} as any),/history_scope_unavailable/);
 assert.equal(f.state.queries.length,0);
});
test('exact active grant precedes native reading; revoke during I/O discards fetched content',async()=>{
 for(const early of [true,false]){
  const f=fixture();if(early)f.state.approved=false;let calls=0;
  const reader=createAuthorizedReceptionHistoryReader(f.db,{page:async()=>{calls++;assert.equal(f.state.connections,0);f.state.approved=false;return {outcome:'ready',page:{scanned:1,next_cursor:null,rows:[row()]}};}},{enabled:()=>true});
  await assert.rejects(()=>reader.read(scope),/history_authorization_unavailable/);assert.equal(calls,early?0:1);assert.equal(f.state.connections,0);
 }
});
test('current customer cannot fall back to whole tenant; excessive or changed contact bindings reject',async()=>{
 for(const contacts of [[],Array.from({length:9},(_,i)=>String(i+1))]){
  const f=fixture();f.state.contacts=contacts;let calls=0;
  await assert.rejects(()=>createAuthorizedReceptionHistoryReader(f.db,{page:async()=>{calls++;throw Error();}},{enabled:()=>true}).read(scope),/history_scope_unavailable/);assert.equal(calls,0);
 }
 const f=fixture(),reader=createAuthorizedReceptionHistoryReader(f.db,{page:async()=>{f.state.contacts=['42'];return {outcome:'ready',page:{scanned:1,next_cursor:null,rows:[row()]}};}},{enabled:()=>true});
 await assert.rejects(()=>reader.read(scope),/history_scope_unavailable/);
 const g=fixture(),other=createAuthorizedReceptionHistoryReader(g.db,{page:async()=>({outcome:'ready',page:{scanned:1,next_cursor:null,rows:[row('1','Foreign',{contact_id:'42'})]}})},{enabled:()=>true});
 await assert.rejects(()=>other.read(scope),/history_native_unavailable/);
});
test('context masks known customer values and obvious identifiers locally, never emits profile or raw source text',async()=>{
 const f=fixture(),text='Synthetic Name synthetic@example.invalid 13800138000 身份证 110101199001011234 密码：123456';
 const reader=createAuthorizedReceptionHistoryReader(f.db,{page:async req=>{
  assert.equal(f.state.connections,0);assert.deepEqual(req.contact_ids,['41']);assert.equal(req.grant_id,scope.grantId);
  return {outcome:'ready',page:{scanned:1,next_cursor:null,rows:[row('1',text)]}};
 }},{enabled:()=>true});
 const result=await reader.read(scope);assert.equal(result.purpose,'context');if(result.purpose==='context'){
  assert.equal(result.messages[0].customerId,scope.customerId);assert.match(result.messages[0].text,/隐藏/);
  for(const raw of ['Synthetic Name','synthetic@example.invalid','13800138000','110101199001011234','123456'])assert.ok(!JSON.stringify(result).includes(raw));
  assert.equal(result.privacyPolicy,'history-redaction-v1');assert.ok(Object.isFrozen(result.messages[0]));
 }
 assert.ok(f.state.grantChecks>=4);assert.equal(f.state.connections,0);
});
test('style returns aggregates only, no message/customer/agent text or identifiers',async()=>{
 const f=fixture(),reader=createAuthorizedReceptionHistoryReader(f.db,{page:async()=>({outcome:'ready',page:{scanned:9,next_cursor:null,
  rows:Array.from({length:9},(_,i)=>row(String(i+1),'亲亲，您好呀~',{direction:'outgoing',author_kind:'human',conversation_id:String(i%3+1)}))}})},{enabled:()=>true});
 const {customerId,...base}=scope;const result=await reader.read({...base,purpose:'style'});assert.equal(result.purpose,'style');
 if(result.purpose==='style'){assert.equal(result.style.tone,'friendly_detailed');assert.equal(result.style.sampleMessages,9);}
 assert.ok(!JSON.stringify(result).includes('亲亲'));assert.equal(Object.hasOwn(result,'messages'),false);
});
test('three scan pages are a hard ceiling even when filtering/shortage prevents a full sample',async()=>{
 const f=fixture();let calls=0;
 const reader=createAuthorizedReceptionHistoryReader(f.db,{page:async()=>{
  calls++;return {outcome:'ready',page:{scanned:200,rows:[],next_cursor:{created_at:new Date(now-calls*1000).toISOString(),message_id:String(1000-calls)}}};
 }},{enabled:()=>true});
 const result=await reader.read(scope);assert.equal(calls,3);assert.equal(result.scanned,600);assert.equal(result.pages,3);
});
test('merging pages cannot exceed page policy or global 80/20/16k sample bounds',async()=>{
 const f=fixture();let calls=0;
 const reader=createAuthorizedReceptionHistoryReader(f.db,{page:async()=>{
  calls++;const rows=Array.from({length:200},(_,i)=>row(String((calls-1)*200+i+1),'x'.repeat(i%2?1:1999),{conversation_id:String(i%30+1)}));
  return {outcome:'ready',page:{scanned:200,rows,next_cursor:{created_at:new Date(now-calls*200000).toISOString(),message_id:String(calls*200)}}};
 }},{enabled:()=>true});
 const result=await reader.read(scope);if(result.purpose!=='style'){
  assert.ok(result.messages.length<=80);assert.ok(new Set(result.messages.map(r=>r.conversationId)).size<=20);assert.ok(result.messages.reduce((n,r)=>n+r.text.length,0)<=16000);
 }
});
test('database/native failure and stopped gate leak no backend/private exception, never retry',async()=>{
 const f=fixture();let calls=0;const reader=createAuthorizedReceptionHistoryReader(f.db,{page:async()=>{calls++;throw Error('private_credentials_marker');}},{enabled:()=>true});
 await assert.rejects(()=>reader.read(scope),e=>e instanceof Error&&e.message==='history_read_unavailable');assert.equal(calls,1);
 const g=fixture();let enabled=true;const stopped=createAuthorizedReceptionHistoryReader(g.db,{page:async()=>{enabled=false;return {outcome:'ready',page:{scanned:1,rows:[row()],next_cursor:null}};}},{enabled:()=>enabled});
 await assert.rejects(()=>stopped.read(scope),/history_read_disabled/);assert.equal(g.state.connections,0);
});
test('redaction is bounded and cannot be claimed to remove every kind of private information',()=>{
 const value=redactReceptionHistoryText('姓名：张三\n邮箱 a@example.invalid 手机 +86 13800138000 sk-abcdefghijklmn 银行账号：1234567890123456');
 assert.match(value,/姓名：\[敏感内容已隐藏\]/);for(const v of ['a@example.invalid','13800138000','abcdefghijklmn','1234567890123456'])assert.ok(!value.includes(v));
 assert.throws(()=>redactReceptionHistoryText('x'.repeat(4001)));assert.throws(()=>redactReceptionHistoryText('value',['a','b','c','d']));
 assert.equal(redactReceptionHistoryText('通常两个工作日发货'),'通常两个工作日发货');
 const link=redactReceptionHistoryText('https://example.invalid/reset?token=secret123 AppSecret：secret456');
 assert.ok(!link.includes('secret123'));assert.ok(!link.includes('secret456'));assert.ok(link.includes('https://example.invalid/reset'));
});
