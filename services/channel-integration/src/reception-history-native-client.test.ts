import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {createReceptionHistoryNativeClient,createCustomerInsightsHistoryClient,validateInsightsHistoryRequest,validateNativeHistoryRequest,type NativeHistoryRequest,type NativeInsightsHistoryRequest} from './reception-history-native-client.js';
const origin='http://fixture-native.invalid',secret='isolated-history-key-0000000000000000000',now=Date.parse('2026-10-06T00:00:00.000Z');
const request:NativeHistoryRequest={account_id:'9007199254740993',purpose:'context',grant_id:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',as_of:'2026-10-06T00:00:00.000000Z',contact_ids:['4'],cursor:null};
const row=(id='9',at='2026-10-05T23:59:59.000000Z')=>({account_id:request.account_id,contact_id:'4',inbox_id:'5',conversation_id:'6',message_id:id,created_at:at,direction:'outgoing',author_kind:'human',text:'Synthetic human reply'});
function echo(body:string,extra:Record<string,unknown>={}){const p=JSON.parse(body);return {state:'ready',request_sha256:createHash('sha256').update(body).digest('hex'),account_id:p.account_id,purpose:p.purpose,grant_id:p.grant_id,as_of:p.as_of,scanned:1,next_cursor:null,rows:[row()],...extra};}
const client=(fetcher:typeof fetch,extra:Record<string,unknown>={})=>createReceptionHistoryNativeClient({origin,secret,now:()=>now,enabled:()=>true,fetcher,...extra});
test('history read is default-off and never treats transport config as consent',async()=>{
 const c=createReceptionHistoryNativeClient({origin,secret,now:()=>now,fetcher:async()=>assert.fail('no network')});
 assert.deepEqual(await c.page(request),{outcome:'rejected'});
});
test('new insight purpose is independently default-off and rejects all legacy purposes before transport',async()=>{
 const input:NativeInsightsHistoryRequest={...request,purpose:'customerInsights',after:null,event_ids:[]};let calls=0;
 const fetcher:typeof fetch=async()=>{calls++;assert.fail('no network');};
 assert.deepEqual(await createCustomerInsightsHistoryClient({origin,secret,now:()=>now,fetcher}).page(input),{outcome:'rejected'});
 const c=createCustomerInsightsHistoryClient({origin,secret,now:()=>now,fetcher,enabled:()=>true});
 for(const purpose of ['context','style','knowledgeDraft'])assert.deepEqual(await c.page({...input,purpose} as NativeInsightsHistoryRequest),{outcome:'rejected'});
 assert.deepEqual(await c.page({...input,contact_ids:[]}),{outcome:'rejected'});assert.equal(calls,0);
 assert.throws(()=>validateNativeHistoryRequest(input,now));assert.equal(validateInsightsHistoryRequest(input,now).purpose,'customerInsights');
});
test('insight transport signs its independent fixed path and rejects old-purpose envelope or body hash',async()=>{
 const input:NativeInsightsHistoryRequest={...request,purpose:'customerInsights',after:null,event_ids:[]};
 for(const change of [{},{purpose:'context'},{request_sha256:'0'.repeat(64)}]){
  const c=createCustomerInsightsHistoryClient({origin,secret,now:()=>now,enabled:()=>true,fetcher:async(url,init)=>{
   const path='/internal/saas_sso/customer_insights_history/page',body=init!.body as string,h=init!.headers as Record<string,string>;
   assert.equal(url,origin+path);assert.equal(h['x-automatic-signature'],createHmac('sha256',secret).update(`${path}\n${h['x-automatic-timestamp']}\n${h['x-automatic-nonce']}\n${body}`).digest('hex'));
   return Response.json(echo(body,{scan_cursor:{created_at:row().created_at,message_id:row().message_id},event_seen_ids:[],...change}));
  }});assert.equal((await c.page(input)).outcome,Object.keys(change).length?'unavailable':'ready');
 }
});

test('insight chronological transport permits only explicit late events and bounded authenticated event receipts',async()=>{
 const input:NativeInsightsHistoryRequest={...request,purpose:'customerInsights',after:{created_at:request.as_of,message_id:'9223372036854775807'},event_ids:['9']};
 for(const [change,ok] of [[{},true],[{event_seen_ids:['9','9']},false],[{event_seen_ids:['10']},false],[{event_seen_ids:undefined},false],
  [{rows:[row('10')]},false],[{scan_cursor:null},false]] as const){
  const c=createCustomerInsightsHistoryClient({origin,secret,now:()=>now,enabled:()=>true,fetcher:async(_url,init)=>Response.json(echo(init!.body as string,
   {scan_cursor:{created_at:row().created_at,message_id:'9'},event_seen_ids:['9'],...change}))});
  assert.equal((await c.page(input)).outcome,ok?'ready':'unavailable');
 }
 for(const change of [{event_ids:['9','9']},{event_ids:['0']},{event_ids:Array.from({length:101},(_,i)=>String(i+1))},{after:{created_at:'2026-10-06T00:00:01.000000Z',message_id:'9'}}])
  assert.throws(()=>validateInsightsHistoryRequest({...input,...change},now));
 const asc=createCustomerInsightsHistoryClient({origin,secret,now:()=>now,enabled:()=>true,fetcher:async(_url,init)=>Response.json(echo(init!.body as string,
  {scanned:2,rows:[row('10'),row('9')],scan_cursor:{created_at:row().created_at,message_id:'10'},event_seen_ids:[]}))});
 assert.equal((await asc.page({...input,after:null,event_ids:[]})).outcome,'unavailable');
});
test('fixed signed read route binds exact purpose/grant/snapshot/contact set and bigint identity',async()=>{
 const c=client(async(url,init)=>{
  assert.equal(url,origin+'/internal/saas_sso/reception_history/page');assert.equal(init!.redirect,'error');const body=init!.body as string,h=init!.headers as Record<string,string>;
  assert.equal(JSON.parse(body).account_id,'9007199254740993');assert.equal(h['x-automatic-signature'],createHmac('sha256',secret).update(`/internal/saas_sso/reception_history/page\n${h['x-automatic-timestamp']}\n${h['x-automatic-nonce']}\n${body}`).digest('hex'));
  return Response.json(echo(body));
 });
 const result=await c.page(request);assert.equal(result.outcome,'ready');if(result.outcome==='ready'){assert.ok(Object.isFrozen(result.page.rows[0]));assert.equal(result.page.rows[0].text,'Synthetic human reply');}
});
test('caller cannot choose SQL/limit/offset/URL, excessive contacts or expired/invalid snapshot',async()=>{
 let calls=0;const c=client(async()=>{calls++;throw Error();});
 for(const change of [{sql:'SELECT *'}, {limit:999},{offset:1},{account_id:'0'},{contact_ids:[]},{contact_ids:['4','4']},{contact_ids:Array.from({length:9},(_,i)=>String(i+1))},
  {as_of:'2026-02-30T00:00:00.000000Z'},{as_of:'2026-10-05T23:50:00.000000Z'},{purpose:'all'},{cursor:{created_at:'2026-10-06T00:00:01.000000Z',message_id:'9'}}])
  assert.deepEqual(await c.page({...request,...change} as NativeHistoryRequest),{outcome:'rejected'});
 assert.equal(calls,0);assert.equal(validateNativeHistoryRequest({...request,purpose:'style',contact_ids:[]},now).purpose,'style');
});
test('native reply cannot drift tenant/account/customer/grant/purpose/hash or expose extra privacy fields',async()=>{
 for(const change of [{account_id:'3'},{purpose:'style'},{grant_id:'bbbbbbbb-1111-4111-8111-aaaaaaaaaaaa'},{request_sha256:'0'.repeat(64)},
  {rows:[{...row(),contact_id:'8'}]},{rows:[{...row(),author_kind:'ai'}]},{rows:[{...row(),private:true}]},{rows:[{...row(),text:'\0'}]},
  {rows:[{...row(),created_at:'2026-10-06T00:00:01.000000Z'}]},{scanned:201},{scanned:0}, {approved:true}]){
  const c=client(async(_u,i)=>Response.json(echo(i!.body as string,change)));assert.deepEqual(await c.page(request),{outcome:'unavailable'});
 }
});
test('duplicate escaped keys at envelope or row level fail closed; repeated row field names across rows are valid',async()=>{
 for(const replace of [(s:string)=>s.replace('"state":"ready"','"state":"ready","st\\u0061te":"ready"'),
  (s:string)=>s.replace('"text":"Synthetic human reply"','"text":"Synthetic human reply","te\\u0078t":"changed"')]){
  const c=client(async(_u,i)=>new Response(replace(JSON.stringify(echo(i!.body as string)))));assert.deepEqual(await c.page(request),{outcome:'unavailable'});
 }
 const good=client(async(_u,i)=>Response.json(echo(i!.body as string,{scanned:2,rows:[row('10'),row('9')]})));
 assert.equal((await good.page(request)).outcome,'ready');
});
test('keyset progression survives filtered-empty page but cannot loop, regress or overlap',async()=>{
 const next={created_at:'2026-10-05T23:59:00.000000Z',message_id:'9'};
 const c=client(async(_u,i)=>Response.json(echo(i!.body as string,{scanned:200,rows:[],next_cursor:next})));
 assert.equal((await c.page(request)).outcome,'ready');assert.deepEqual(await c.page({...request,cursor:next}),{outcome:'unavailable'});
 for(const rows of [[row('9'),row('10')],[row('9'),row('9')],[row('8','2026-10-05T23:58:00.000000Z')]]){
  const f=client(async(_u,i)=>Response.json(echo(i!.body as string,{scanned:200,rows,next_cursor:next})));assert.deepEqual(await f.page(request),{outcome:'unavailable'});
 }
});
test('purpose-specific style cannot return customer text; changed caller input cannot alter captured signed body',async()=>{
 const c=client(async(_u,i)=>Response.json(echo(i!.body as string,{rows:[{...row(),direction:'incoming',author_kind:'customer'}]})));
 assert.deepEqual(await c.page({...request,purpose:'style',contact_ids:[]}),{outcome:'unavailable'});
 const mutable=structuredClone(request),f=client(async(_u,i)=>Response.json(echo(i!.body as string)));
 const pending=f.page(mutable);(mutable as any).account_id='3';(mutable.contact_ids as string[])[0]='7';assert.equal((await pending).outcome,'ready');
});
test('late gate closure and malformed/oversized/HTTP response return unavailable without leaking diagnostics',async()=>{
 for(const respond of [()=>new Response(new Uint8Array([255,254])),()=>new Response('x'.repeat(2*1024*1024+1)),()=>new Response('private_native_error',{status:503})]){
  assert.deepEqual(await client(async()=>respond()).page(request),{outcome:'unavailable'});
 }
 let enabled=true;const c=client(async(_u,i)=>{enabled=false;return Response.json(echo(i!.body as string));},{enabled:()=>enabled});assert.deepEqual(await c.page(request),{outcome:'unavailable'});
});
test('one real two-second deadline bounds a stalled transport and a stalled response stream; no retry',async()=>{
 for(const stream of [false,true]){
  let calls=0;const c=client(async()=>{calls++;return stream?new Response(new ReadableStream()):new Promise<Response>(()=>{});});
  const start=Date.now();assert.deepEqual(await c.page(request),{outcome:'unavailable'});assert.equal(calls,1);assert.ok(Date.now()-start<2600);
 }
});
