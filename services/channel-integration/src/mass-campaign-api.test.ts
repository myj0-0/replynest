import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import type {IncomingMessage,ServerResponse} from 'node:http';
test('review API rejects agent, supervisor and API-key callers before database access',async()=>{
 Object.assign(process.env,{POSTGRES_HOST:'127.0.0.1',POSTGRES_DATABASE:'unused',POSTGRES_USERNAME:'unused',POSTGRES_PASSWORD:'unused'});
 const {handleMessageCampaignApi}=await import('./message-campaign-api.js');
 const {pool}=await import('./database.js');
 const previous=pool.connect;let connections=0;
 (pool as any).connect=async()=>{connections++;throw Error('unexpected_database_access');};
 try{
  for(const [role,auth_kind,code] of [['agent','console_session','tenant_admin_required'],['supervisor','console_session','tenant_admin_required'],['tenant_admin','api_key','console_session_required']] as const){
   const request=Readable.from([Buffer.from(JSON.stringify({reason:'Synthetic review evidence'}))]) as IncomingMessage;
   request.method='POST';request.headers={};let status=0,body='';
   const response={writeHead(n:number){status=n;},setHeader(){},end(v:string){body=v;}} as unknown as ServerResponse;
   await handleMessageCampaignApi(request,response,new URL('https://synthetic.invalid/api/v1/message-campaigns/00000000-0000-4000-8000-000000000001/mass-batches/00000000-0000-4000-8000-000000000002/review'),{tenant_id:'synthetic',role,auth_kind,actor_id:'synthetic'},'synthetic-request');
   assert.equal(status,403);assert.equal(JSON.parse(body).error.code,code);
  }
  assert.equal(connections,0);
 }finally{pool.connect=previous;await pool.end();}
});
