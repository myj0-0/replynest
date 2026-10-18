import {createHash,createHmac,randomBytes} from 'node:crypto';
export type VerifiedWeChatIngress={commandId:string;accountId:string;inboxId:string;connectionId:string;appId:string;openId:string;
 sourceEventId:string;externalMessageId:string;sourceOccurredAt:string;content:string};
export type VerifiedWeChatIngressResult={outcome:'accepted';accountId:string;inboxId:string;contactId:string;conversationId:string;messageId:string;sourceId:string}|{outcome:'rejected'|'uncertain'};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const id=(s:unknown):s is string=>typeof s==='string'&&/^[1-9]\d{0,18}$/.test(s)&&BigInt(s)<=9223372036854775807n;
const uuid=(s:unknown):s is string=>typeof s==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(s);
export function createVerifiedWeChatIngressClient(options:{origin:string;secret:string;enabled?:()=>boolean;fetcher?:typeof fetch}){
 const origin=new URL(options.origin);
 if(!['http:','https:'].includes(origin.protocol)||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash||
  Buffer.byteLength(options.secret)<32||Buffer.byteLength(options.secret)>65536||options.secret.includes('\0'))throw Error('invalid_verified_ingress_config');
 const fetcher=options.fetcher??fetch,enabled=options.enabled??(()=>false);
 return {project:async(input:VerifiedWeChatIngress):Promise<VerifiedWeChatIngressResult>=>{
  if(!enabled())return {outcome:'rejected'};
  const r={...input};
  if(!uuid(r.commandId)||!uuid(r.connectionId)||![r.accountId,r.inboxId].every(id)||typeof r.appId!=='string'||!/^wx[a-f0-9]{16}$/.test(r.appId)||
   typeof r.openId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(r.openId)||typeof r.content!=='string'||!r.content.trim()||r.content.length>4000||
   Buffer.from(r.content).toString('utf8')!==r.content||r.content.includes('\0')||
   ![r.sourceEventId,r.externalMessageId].every(s=>typeof s==='string'&&!!s.trim()&&!s.includes('\0'))||
   Buffer.byteLength(r.sourceEventId)>200||Buffer.byteLength(r.externalMessageId)>128||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.sourceOccurredAt)||
   !Number.isFinite(Date.parse(r.sourceOccurredAt))||new Date(r.sourceOccurredAt).toISOString()!==r.sourceOccurredAt)return {outcome:'rejected'};
  // Same canonical key ordering as native KEYS; command ID is not the provider dedup binding.
  const binding={account_id:r.accountId,inbox_id:r.inboxId,connection_id:r.connectionId,app_id:r.appId,open_id:r.openId,
   source_event_id:r.sourceEventId,external_message_id:r.externalMessageId,source_occurred_at:r.sourceOccurredAt,content:r.content};
  const path='/internal/saas_sso/verified_wechat/ingress',body=JSON.stringify({command_id:r.commandId,...binding}),ts=String(Date.now()),nonce=randomBytes(16).toString('hex');
  const signature=createHmac('sha256',options.secret).update(`${path}\n${ts}\n${nonce}\n${body}`).digest('hex');
  const ctrl=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{ctrl.abort();reject(Error('ingress_deadline'));},4000);});
   const operation=(async()=>{
    const response=await fetcher(origin.origin+path,{method:'POST',redirect:'error',signal:ctrl.signal,body,
     headers:{'content-type':'application/json','x-forwarded-proto':'https','x-automatic-timestamp':ts,'x-automatic-nonce':nonce,'x-automatic-signature':signature}});
    if(!response.body)throw Error('missing_body');
    const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
    let v:any;try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>16384)throw Error('body_limit');parts.push(chunk.value);}
     v=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(parts)));
    }finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
    const exact=(keys:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');
    if(response.status!==200)return {outcome:exact(['error'])&&((response.status===401&&v.error==='unauthorized')||(response.status===422&&v.error==='invalid_payload'))?'rejected':'uncertain'} as VerifiedWeChatIngressResult;
    if(exact(['state','command_id'])&&v.command_id===r.commandId&&['rejected','binding_conflict'].includes(v.state))return {outcome:'rejected'} as VerifiedWeChatIngressResult;
    if(!exact(['state','command_id','account_id','inbox_id','contact_id','conversation_id','message_id','source_id','source_event_id','content_sha256','binding_sha256'])||
     v.state!=='accepted'||v.command_id!==r.commandId||v.account_id!==r.accountId||v.inbox_id!==r.inboxId||v.source_event_id!==r.sourceEventId||
     ![v.contact_id,v.conversation_id,v.message_id].every(id)||typeof v.source_id!=='string'||!v.source_id.trim()||v.source_id.length>200||v.source_id.includes('\0')||
     v.content_sha256!==hash(r.content)||v.binding_sha256!==hash(JSON.stringify(binding)))return {outcome:'uncertain'} as VerifiedWeChatIngressResult;
    return {outcome:'accepted',accountId:r.accountId,inboxId:r.inboxId,contactId:v.contact_id,conversationId:v.conversation_id,messageId:v.message_id,sourceId:v.source_id} as VerifiedWeChatIngressResult;
   })();
   return await Promise.race([operation,deadline]);
  }catch{return {outcome:'uncertain'};}finally{if(timer)clearTimeout(timer);ctrl.abort();}
 }};
}
