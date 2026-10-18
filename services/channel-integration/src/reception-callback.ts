import type {IncomingMessage,ServerResponse} from 'node:http';
import {secretValue} from './secret-value.js';
import {readBody,sendJson} from './shared.js';
import {authenticateChatwootCallback} from './chatwoot-callback-security.js';
import {acceptReceptionCallback} from './reception-events.js';

/** Shared production HTTP boundary, also exercised by isolated cross-language acceptance. */
export async function handleReceptionCallback(request:IncomingMessage,response:ServerResponse){
  const key=secretValue('CHATWOOT_CALLBACK_SECRET');
  if(process.env.AI_RECEPTION_EVENT_CALLBACK_ENABLED!=='true'||process.env.AI_RECEPTION_DRAFT_WORKER_ENABLED!=='true'||!key||Buffer.byteLength(key)<32)
    return sendJson(response,404,{error:'not_found'});
  const body=await readBody(request);
  if(!authenticateChatwootCallback(key,request.headers['x-replynest-chatwoot-timestamp'],request.headers['x-replynest-chatwoot-signature'],body))
    return sendJson(response,401,{error:'invalid_callback_authentication'});
  let payload:unknown;
  try{payload=JSON.parse(body.toString('utf8'));}catch{return sendJson(response,400,{error:'invalid_json'});}
  await acceptReceptionCallback(payload);
  return sendJson(response,200,{ok:true});
}
