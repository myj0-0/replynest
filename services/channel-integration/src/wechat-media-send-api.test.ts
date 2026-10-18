import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {handleWechatMediaSend} from './wechat-media-send-api.js';
import {pool} from './database.js';
const id='f4e98bea-a0d3-4bb1-8990-b0762742f632';
test('HTTP media command gates, membership and cached uncertain/accepted commands never send again',async()=>{
  const previous=process.env.WECHAT_MEDIA_ENABLED,query=pool.query;let scenario='disabled',queries=0;
  (pool as any).query=async(sql:string)=>{queries++;
    if(sql.includes('FROM conversation_resource_mappings'))return {rows:scenario==='foreign'?[]:[{account_id:'11',conversation_id:'22'}]};
    if(sql.includes('INSERT INTO conversation_message_commands'))return {rows:[]};
    if(sql.includes('SELECT * FROM conversation_message_commands'))return {rows:[{request_hash:scenario==='conflict'?'different':requestHash,response_status:scenario==='accepted'?202:scenario==='uncertain'?503:null,response_body:scenario==='accepted'?{data:{state:'accepted'}}:scenario==='uncertain'?{error:{code:'send_outcome_uncertain'}}:null}]};
    throw Error('unexpected database access');
  };
  const {createHash}=await import('node:crypto');const requestHash=createHash('sha256').update(JSON.stringify(['wechat-media',id,id])).digest('hex');
  const auth:any={tenant_id:'synthetic',actor_id:id,platform_user_id:id,auth_kind:'console_session'};
  const server=createServer(async(req,res)=>{await handleWechatMediaSend(req,res,new URL(req.url!,'http://local'),auth,'synthetic-request');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');
  const send=(body:any={file_transfer_id:id})=>fetch(`http://127.0.0.1:${address.port}/api/v1/conversations/${id}/media`,{method:'POST',headers:{'idempotency-key':'synthetic-command'},body:JSON.stringify(body)});
  try{
    process.env.WECHAT_MEDIA_ENABLED='false';assert.equal((await send()).status,409);assert.equal(queries,0);
    process.env.WECHAT_MEDIA_ENABLED='true';auth.auth_kind='api_key';assert.equal((await send()).status,403);assert.equal(queries,0);auth.auth_kind='console_session';
    assert.equal((await send({file_transfer_id:id,recipient:'injected'})).status,400);assert.equal(queries,0);
    scenario='foreign';assert.equal((await send()).status,404);
    scenario='accepted';const accepted=await send();assert.equal(accepted.status,202);assert.equal((await accepted.json()).data.state,'accepted');
    scenario='uncertain';assert.equal((await send()).status,503);
    scenario='processing';assert.equal((await send()).status,409);
    scenario='conflict';const conflict=await send();assert.equal(conflict.status,409);assert.equal((await conflict.json()).error.code,'idempotency_key_conflict');
  }finally{pool.query=query;if(previous===undefined)delete process.env.WECHAT_MEDIA_ENABLED;else process.env.WECHAT_MEDIA_ENABLED=previous;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();}
});
