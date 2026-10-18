import {createHash,createHmac,randomBytes} from 'node:crypto';
import {parseAutomaticNativeSnapshot,type AutomaticNativeAddress,type AutomaticNativeFence} from './automatic-web-native-client.js';
export type AutomaticWeChatNativeTarget=Readonly<AutomaticNativeAddress & {
 customerId:string;authorizationAt:string;provider:'wechat_official_account'|'shared_wechat';contactIdentifier:string;
 sourceEventId:string;sourceOccurredAt:string;
}>;
export type AutomaticWeChatPermission={outcome:'authorized';expiresAt:string}|{outcome:'rejected'|'uncertain'};
const hash=(v:string)=>createHash('sha256').update(v,'utf8').digest('hex');
const id=(v:unknown)=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const iso=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(v)&&Number.isFinite(Date.parse(v));
const record=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const keys=(r:Record<string,unknown>,list:string[])=>Object.keys(r).sort().join(',')===[...list].sort().join(',');
export function automaticWeChatTargetPayload(t:AutomaticWeChatNativeTarget,messageId:string){
 if(![t.accountId,t.conversationId,t.inboxId,t.contactId,messageId].every(id)||!iso(t.authorizationAt)||!iso(t.sourceOccurredAt)||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(t.customerId)||
  !['wechat_official_account','shared_wechat'].includes(t.provider)||typeof t.contactIdentifier!=='string'||
  !(t.provider==='shared_wechat'?/^rn_shared_[a-f0-9]{64}$/:/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}:[a-zA-Z0-9_-]{1,128}$/).test(t.contactIdentifier)||
  typeof t.sourceEventId!=='string'||!t.sourceEventId.trim()||Buffer.byteLength(t.sourceEventId)>200||t.sourceEventId.includes('\0'))throw Error('invalid_automatic_wechat_target');
 // Match the native slice's fixed field ordering for the binding digest.
 return {account_id:t.accountId,conversation_id:t.conversationId,inbox_id:t.inboxId,contact_id:t.contactId,message_id:messageId,
  authorization_at:t.authorizationAt,customer_id:t.customerId,provider:t.provider,contact_identifier:t.contactIdentifier,source_event_id:t.sourceEventId,source_occurred_at:t.sourceOccurredAt};
}
async function json(response:Response){
 if(!response.body)throw Error('missing_native_body');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>128*1024)throw Error('body_limit');chunks.push(r.value);}
  return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));
 }finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** Short-lived, one-source permission only; does not create a native public message
 * or send to WeChat. The gateway commits a durable CAS BEFORE requesting permission,
 * then rechecks local consent/routing AFTER it and BEFORE the provider request.
 * Never renew/retry a lost/expired permission or reopen the marker.
 */
export function createAutomaticWeChatNativeClient(options:{origin:string;secret:string;now?:()=>number;fetcher?:typeof fetch}){
 let origin:URL;try{origin=new URL(options.origin);}catch{throw Error('invalid_automatic_wechat_native_config');}
 if(!['https:','http:'].includes(origin.protocol)||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash||
  typeof options.secret!=='string'||Buffer.byteLength(options.secret)<32||Buffer.byteLength(options.secret)>65536||options.secret.includes('\0'))throw Error('invalid_automatic_wechat_native_config');
 const fetcher=options.fetcher??fetch,now=options.now??Date.now;
 async function post(action:'snapshot'|'authorize',input:unknown){
  const path=`/internal/saas_sso/automatic_wechat/${action}`,body=JSON.stringify(input),timestamp=String(now()),nonce=randomBytes(16).toString('hex');
  if(Buffer.byteLength(body)>32768||!/^\d{13}$/.test(timestamp))throw Error('invalid_native_payload');
  const signature=createHmac('sha256',options.secret).update(`${path}\n${timestamp}\n${nonce}\n${body}`).digest('hex');
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('native_deadline'));},2000);});
   const operation=(async()=>{const r=await fetcher(`${origin.origin}${path}`,{method:'POST',redirect:'error',signal:controller.signal,
    headers:{'content-type':'application/json',accept:'application/json','x-forwarded-proto':'https',
     'x-automatic-timestamp':timestamp,'x-automatic-nonce':nonce,'x-automatic-signature':signature},body});
    return {status:r.status,body:await json(r)};})();
   return await Promise.race([operation,deadline]);
  }finally{if(timer)clearTimeout(timer);controller.abort();}
 }
 return {
  snapshot:async(t:AutomaticWeChatNativeTarget,messageId:string)=>{
   try{const payload=automaticWeChatTargetPayload(t,messageId),address={accountId:payload.account_id,conversationId:payload.conversation_id,inboxId:payload.inbox_id,contactId:payload.contact_id};
    const r=await post('snapshot',payload);if(r.status!==200)throw Error('native_unavailable');
    return parseAutomaticNativeSnapshot(r.body,address,messageId);
   }catch{throw Error('automatic_wechat_native_snapshot_unavailable');}
  },
  authorize:async(t:AutomaticWeChatNativeTarget,messageId:string,commandId:string,content:string,fence:AutomaticNativeFence):Promise<AutomaticWeChatPermission>=>{
   try{
    if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(commandId)||typeof content!=='string'||!content.trim()||
     Buffer.byteLength(content)>1800||content.includes('\0')||Buffer.from(content,'utf8').toString('utf8')!==content)return {outcome:'rejected'};
    const payload=automaticWeChatTargetPayload(t,messageId),r=await post('authorize',{...payload,command_id:commandId,content,fence}),v=record(r.body);
    if(!v)return {outcome:'uncertain'};
    if(r.status!==200){
     const definite=keys(v,['error'])&&((r.status===401&&v.error==='unauthorized')||(r.status===422&&v.error==='invalid_payload'));
     return {outcome:definite?'rejected':'uncertain'};
    }
    if(keys(v,['state','command_id'])&&v.command_id===commandId&&['rejected','state_changed'].includes(String(v.state)))return {outcome:'rejected'};
    if(!keys(v,['state','command_id','account_id','conversation_id','inbox_id','contact_id','source_message_id','provider','content_sha256','binding_sha256','expires_at'])||
     v.state!=='transport_authorized'||v.command_id!==commandId||v.account_id!==payload.account_id||v.conversation_id!==payload.conversation_id||
     v.inbox_id!==payload.inbox_id||v.contact_id!==payload.contact_id||v.source_message_id!==messageId||v.provider!==payload.provider||
     v.content_sha256!==hash(content)||v.binding_sha256!==hash(JSON.stringify(payload))||!iso(v.expires_at))return {outcome:'uncertain'};
    const expiry=Date.parse(v.expires_at),current=now();
    // An old replay is not a new lease. Clock disagreement also fails closed.
    if(!Number.isSafeInteger(current)||expiry<=current||expiry-current>5000)return {outcome:'rejected'};
    return Object.freeze({outcome:'authorized',expiresAt:v.expires_at});
   }catch{return {outcome:'uncertain'};}
  }
 };
}
