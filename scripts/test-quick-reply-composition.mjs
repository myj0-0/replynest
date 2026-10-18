import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';
const require=createRequire(new URL('../apps/console/package.json',import.meta.url)),ts=require('typescript'),m={exports:{}};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../apps/console/app/workbench/quick-reply-composition.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:m.exports,AbortSignal});
const {sendQuickReplyComposition:send}=m.exports,id='90000000-0000-4000-a000-000000000001';
const base={conversationId:id,key:'synthetic-manual-action',imageAccepted:false,text:'caption',item:{quick_reply_id:id,updated_at:'2026-10-13T00:00:00.000Z',image:{asset_id:id,file_name:'logo.png'}}};
const accepted={status:202,body:{data:{state:'accepted',delivery_state:'wechat_media_provider_accepted'}}};
function fixture(sequence){const requests=[],image=[];return {requests,image,dep:{imageAccepted:()=>image.push(true),failure:state=>state==='shared_window_expired'?'expired':undefined,fetcher:async(url,opts)=>{requests.push({url,opts});const next=sequence[requests.length-1];if(next instanceof Error)throw next;return {status:next.status,json:async()=>next.body};}}};}
const prep={status:200,body:{data:{transfer_id:id}}};
test('selection is inert; sending runs prepare, image acceptance, then caption with separate keys',async()=>{
 const f=fixture([prep,accepted,{status:202,body:{data:{state:'accepted',delivery_state:'shared_provider_accepted'}}}]);assert.equal(f.requests.length,0);
 const r=await send(base,f.dep);assert.equal(r.kind,'accepted');assert.equal(f.requests.length,3);assert.equal(f.image.length,1);
 assert.ok(f.requests[1].url.endsWith('/media'));assert.ok(f.requests[2].url.endsWith('/messages'));assert.equal(JSON.parse(f.requests[2].opts.body).private,false);
 assert.equal(new Set(f.requests.map(r=>r.opts.headers['idempotency-key'])).size,3);
});
test('image-only never invokes the text sender',async()=>{const f=fixture([prep,accepted]);assert.equal((await send({...base,text:''},f.dep)).kind,'accepted');assert.equal(f.requests.length,2);});
test('known image failure stops text and allows a manual retry only',async()=>{const f=fixture([prep,{status:409,body:{error:{code:'media_file_unsafe'}}}]);const r=await send(base,f.dep);assert.equal(r.kind,'error');assert.equal(r.imageAccepted,false);assert.equal(f.requests.length,2);});
test('image timeout or malformed success remains uncertain and never sends caption',async()=>{
 for(const next of [Error('network lost'),{status:202,body:{data:{state:'accepted'}}},{status:503,body:{error:{code:'proxy_unavailable'}}}]){const f=fixture([prep,next]);const r=await send(base,f.dep);assert.equal(r.kind,'uncertain');assert.equal(f.requests.length,2);}
});
test('failed caption preserves image acceptance; resumed action sends only text',async()=>{
 const f=fixture([prep,accepted,{status:409,body:{error:{code:'window_expired'}}}]);const r=await send(base,f.dep);assert.equal(r.kind,'error');assert.equal(r.imageAccepted,true);
 const resumed=fixture([{status:202,body:{data:{state:'accepted',delivery_state:'pending'}}}]);const result=await send({...base,key:'manual-new-text-attempt',imageAccepted:true},resumed.dep);assert.equal(result.kind,'accepted');assert.equal(resumed.requests.length,1);assert.ok(resumed.requests[0].url.endsWith('/messages'));assert.equal(result.deliveryState,'pending');
});
test('uncertain text outcome after accepted image locks the whole composition',async()=>{
 for(const next of [Error('lost'),{status:202,body:{data:{state:'accepted',delivery_state:'shared_uncertain'}}},{status:202,body:{data:{state:'accepted'}}},{status:202,body:{data:{state:'accepted',delivery_state:'unexpected'}}},{status:202,body:{}},{status:503,body:{}}]){const f=fixture([prep,accepted,next]);const r=await send(base,f.dep);assert.equal(r.kind,'uncertain');assert.equal(r.imageAccepted,true);assert.equal(f.requests.length,3);}
});
test('provider rejection in a text-accepted envelope is not a successful whole reply',async()=>{const f=fixture([prep,accepted,{status:202,body:{data:{state:'accepted',delivery_state:'shared_window_expired'}}}]);const r=await send(base,f.dep);assert.equal(r.kind,'error');assert.equal(r.imageAccepted,true);});
test('prepare failure never creates a customer send or locks a provider-unknown outcome',async()=>{const f=fixture([Error('prepare connection')]);const r=await send(base,f.dep);assert.equal(r.kind,'error');assert.equal(r.stage,'prepare');assert.equal(f.requests.length,1);});
test('browser fetch is invoked without the dependency object as its receiver',async()=>{
 let calls=0;
 const result=await send({...base,text:''},{imageAccepted:()=>{},failure:()=>undefined,fetcher:async function(){assert.equal(this,undefined);const next=calls++===0?prep:accepted;return {status:next.status,json:async()=>next.body};}});
 assert.equal(result.kind,'accepted');assert.equal(calls,2);
});
