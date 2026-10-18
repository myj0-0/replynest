import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustomerInsightsProjectionReader} from './customer-insights-projection-reader.js';
const e={account:'1',inbox:'4',conversation:'10',message:'100'};
test('default-off metadata reader does not make a request',async()=>{
 let calls=0;const read=createCustomerInsightsProjectionReader({origin:'http://native:3000',token:'synthetic',fetcher:async()=>{calls++;return Response.json({});}});
 await assert.rejects(read(e),/unavailable/);assert.equal(calls,0);
});
test('metadata request has a fixed server destination, no redirect and bounded UTF-8 body',async()=>{
 const read=createCustomerInsightsProjectionReader({origin:'http://native:3000',token:'synthetic',enabled:()=>true,fetcher:async(url,init)=>{
  assert.equal(url,'http://native:3000/api/v1/accounts/1/conversations/10');assert.equal(init?.redirect,'error');assert.equal((init?.headers as Record<string,string>).api_access_token,'synthetic');return Response.json({id:10});}});
 assert.deepEqual(await read(e),{id:10});await assert.rejects(read({...e,account:'../other'}),/unavailable/);
});
test('duplicate JSON keys, malformed UTF-8 and oversized metadata fail without raw data leaks',async()=>{
 for(const body of ['{"id":1,"id":2}',new Uint8Array([0xff]),'a'.repeat(65537)]){
  const read=createCustomerInsightsProjectionReader({origin:'http://native:3000',token:'synthetic',enabled:()=>true,fetcher:async()=>new Response(body)});
  await assert.rejects(read(e),error=>error instanceof Error&&error.message==='insights_projection_unavailable');}
});
test('revocation during metadata I/O suppresses the returned identity',async()=>{
 let enabled=true;const read=createCustomerInsightsProjectionReader({origin:'http://native:3000',token:'synthetic',enabled:()=>enabled,fetcher:async()=>{enabled=false;return Response.json({id:10});}});
 await assert.rejects(read(e),/unavailable/);
});
test('one real deadline bounds a fetcher or body that ignores abort',async()=>{
 for(const fetcher of [async()=>new Promise<Response>(()=>{}),async()=>new Response(new ReadableStream({start(){}}))]){
  const read=createCustomerInsightsProjectionReader({origin:'http://native:3000',token:'synthetic',enabled:()=>true,fetcher});const before=Date.now();
  await assert.rejects(read(e),/unavailable/);assert.ok(Date.now()-before>=1500&&Date.now()-before<5000);}
});
