import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {createAutomaticWebProjection,createAutomaticProjectionReader} from './automatic-web-projection.js';
test('projection is default-off and missing consent does not call native API',async()=>{
 let queries=0,reads=0;const db={query:async()=>{queries++;return {rows:[]};}} as unknown as Pool;
 const input={account:'1',inbox:'2',conversation:'3',message:'4'};
 assert.equal(await createAutomaticWebProjection(db,{read:async()=>{reads++;return {};}})(input),'ignored');assert.equal(queries,0);
 assert.equal(await createAutomaticWebProjection(db,{enabled:()=>true,read:async()=>{reads++;return {};}})(input),'ignored');assert.equal(reads,0);
});
test('reader refuses unsafe origin, paths, redirect and overlarge or invalid UTF-8 bodies',async()=>{
 for(const origin of ['https://bad.invalid/api','https://name:password@bad.invalid','ftp://bad.invalid'])assert.throws(()=>createAutomaticProjectionReader({origin,token:'synthetic-token'}),/invalid/);
 for(const response of [new Response('x'.repeat(65537)),new Response(new Uint8Array([0xff])),new Response('{}',{status:302,headers:{location:'https://evil.invalid'}})]){
  const read=createAutomaticProjectionReader({origin:'http://native.invalid',token:'synthetic-token',fetcher:async(_url,init)=>{assert.equal(init?.redirect,'error');return response;}});
  await assert.rejects(()=>read({account:'1',inbox:'2',conversation:'3',message:'4'}));
 }
});
