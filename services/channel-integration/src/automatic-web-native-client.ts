import {createHash,createHmac,randomBytes} from 'node:crypto';
import type {AutomaticWebTarget} from './automatic-web-chat.js';
import type {AutomaticSubmission} from './automatic-reception-runtime.js';
import type {AutomaticSenderPort,AutomaticSenderState} from './automatic-sender.js';

export type AutomaticNativeFence=Readonly<{revision:string;conversation_updated_at:string;message_updated_at:string;question_sha256:string;customer_pause_revision:string}>;
export type CustomerAutomationState={account_id:string;customer_id:string;revision:string;paused_until:string|null;paused:boolean};
export type CustomerAutomationWrite={operation:'pause'|'resume';minutes:0|10;revision:string;actor_id:string;request_id:string;
 conversation_id:string;contact_id:string;native_actor_id:string;permission_scope:'manager'|'assigned'};
export type AutomaticNativeSnapshot={current:false;human:true;replyable:false;question:null;fence:null}|
 {current:true;human:false;replyable:true;question:string;fence:AutomaticNativeFence};
const denied:AutomaticNativeSnapshot=Object.freeze({current:false,human:true,replyable:false,question:null,fence:null});
const object=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const keys=(v:Record<string,unknown>,expected:string[])=>Object.keys(v).sort().join(',')===[...expected].sort().join(',');
const validId=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const iso=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(v)&&Number.isFinite(Date.parse(v));
const hash=(v:string)=>createHash('sha256').update(v,'utf8').digest('hex');
export type AutomaticNativeAddress=Pick<AutomaticWebTarget,'accountId'|'conversationId'|'inboxId'|'contactId'>;
function matchesTarget(r:Record<string,unknown>,t:AutomaticNativeAddress,messageId:string){
 return r.account_id===t.accountId&&r.conversation_id===t.conversationId&&r.inbox_id===t.inboxId&&r.contact_id===t.contactId&&r.source_message_id===messageId;
}
/** Strict native response parser: no legacy API message response, guessed target or model score. */
export function parseAutomaticNativeSnapshot(value:unknown,t:AutomaticNativeAddress,messageId:string):AutomaticNativeSnapshot{
 const r=object(value);if(r&&keys(r,['state'])&&r.state==='rejected')return denied;
 const f=object(r?.fence);
 if(!r||!keys(r,['state','account_id','conversation_id','inbox_id','contact_id','source_message_id','question','fence'])||
  r.state!=='ready'||!matchesTarget(r,t,messageId)||typeof r.question!=='string'||!r.question.trim()||r.question.length>4000||
  !f||!keys(f,['revision','conversation_updated_at','message_updated_at','question_sha256','customer_pause_revision'])||
  typeof f.customer_pause_revision!=='string'||!/^\d{1,19}$/.test(f.customer_pause_revision)||BigInt(f.customer_pause_revision)>9223372036854775807n||
  typeof f.revision!=='string'||!/^\d{1,19}$/.test(f.revision)||BigInt(f.revision)>9223372036854775807n||
  !iso(f.conversation_updated_at)||!iso(f.message_updated_at)||f.question_sha256!==hash(r.question))throw Error('invalid_automatic_native_snapshot');
 // Do not trim/rewrite the native canonical question or silently refresh this fence.
 return Object.freeze({current:true,human:false,replyable:true,question:r.question,fence:Object.freeze({
  revision:f.revision,conversation_updated_at:f.conversation_updated_at,message_updated_at:f.message_updated_at,question_sha256:String(f.question_sha256),customer_pause_revision:f.customer_pause_revision})});
}
async function boundedJson(response:Response):Promise<unknown>{
 if(!response.body)throw Error('automatic_native_body_missing');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;
  if(size>128*1024)throw Error('automatic_native_body_limit');chunks.push(next.value);
 }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
 catch{throw Error('automatic_native_json_invalid');}
}
/** Internal server config only. No environment lookup, public API token or retry/fallback. */
export function createAutomaticNativeClient(options:{origin:string;secret:string;fetcher?:typeof fetch;now?:()=>Date}){
 let origin:URL;
 try{origin=new URL(options.origin);}catch{throw Error('invalid_automatic_web_config');}
 if(!['http:','https:'].includes(origin.protocol)||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password||
  typeof options.secret!=='string'||options.secret.includes('\0')||Buffer.byteLength(options.secret)<32||Buffer.byteLength(options.secret)>65536)throw Error('invalid_automatic_web_config');
 const fetcher=options.fetcher??fetch,now=options.now??(()=>new Date());
 function payload(t:AutomaticWebTarget,messageId:string){
  if(![t.accountId,t.conversationId,t.inboxId,t.contactId,messageId].every(validId)||!iso(t.authorizationAt)||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(t.customerId))throw Error('invalid_automatic_native_target');
  return {account_id:t.accountId,conversation_id:t.conversationId,inbox_id:t.inboxId,contact_id:t.contactId,message_id:messageId,authorization_at:t.authorizationAt,customer_id:t.customerId};
 }
 async function post(action:'snapshot'|'submit'|'actor'|'customer_control',input:unknown){
  const path=action==='customer_control'?'/internal/saas_sso/customer_automation/control':`/internal/saas_sso/automatic_replies/${action}`,body=JSON.stringify(input),timestamp=String(now().getTime()),nonce=randomBytes(16).toString('hex');
  if(Buffer.byteLength(body)>32768||!/^\d{13}$/.test(timestamp))throw Error('invalid_automatic_native_request');
  const signature=createHmac('sha256',options.secret).update(`${path}\n${timestamp}\n${nonce}\n${body}`,'utf8').digest('hex');
  const response=await fetcher(`${origin.origin}${path}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(2000),
   headers:{'content-type':'application/json',accept:'application/json','x-forwarded-proto':'https',
    'x-automatic-timestamp':timestamp,'x-automatic-nonce':nonce,'x-automatic-signature':signature},body});
  return {status:response.status,ok:response.ok,body:await boundedJson(response)};
 }
 const sender:AutomaticSenderPort={
  inspect:accountId=>actor(accountId,'inspect'),prepare:accountId=>actor(accountId,'prepare')
 };
 async function actor(accountId:string,operation:'inspect'|'prepare'):Promise<AutomaticSenderState>{
  try{
   if(!validId(accountId))return 'unavailable';
   const response=await post('actor',{account_id:accountId,operation}),r=object(response.body);
   if(!response.ok||!r||!keys(r,['state','account_id'])||r.account_id!==accountId||
    !['ready','missing','disabled','invalid'].includes(String(r.state)))return 'unavailable';
   return r.state as AutomaticSenderState;
  }catch{return 'unavailable';}
 }
 return {
  sender,
  customerControl:async(accountId:string,customerId:string,input?:CustomerAutomationWrite):Promise<CustomerAutomationState>=>{
   const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
   if(!validId(accountId)||!uuid.test(customerId)||input&&(!['pause','resume'].includes(input.operation)||
    !(input.operation==='pause'?input.minutes===10:input.minutes===0)||!/^\d{1,19}$/.test(input.revision)||
    !uuid.test(input.actor_id)||!input.request_id||Buffer.byteLength(input.request_id)>200||input.request_id.includes('\0')||
    ![input.conversation_id,input.contact_id,input.native_actor_id].every(validId)||!['manager','assigned'].includes(input.permission_scope)))throw Error('invalid_customer_automation');
   const r=await post('customer_control',{account_id:accountId,customer_id:customerId,...(input??{operation:'read'})});
   if(r.status===409)throw Error('customer_automation_conflict');
   if(r.status===403&&object(r.body)?.error==='pause_forbidden'&&keys(r.body as Record<string,unknown>,['error']))throw Error('customer_automation_forbidden');
   const v=object(r.body);
   if(!r.ok||!v||!keys(v,['account_id','customer_id','revision','paused_until','paused'])||v.account_id!==accountId||v.customer_id!==customerId||
    typeof v.revision!=='string'||!/^\d{1,19}$/.test(v.revision)||typeof v.paused!=='boolean'||!(v.paused_until===null||iso(v.paused_until)))throw Error('customer_automation_unavailable');
   return v as CustomerAutomationState;
  },
  snapshot:async(t:AutomaticWebTarget,messageId:string)=>{
   try{const r=await post('snapshot',payload(t,messageId));if(!r.ok)throw Error('unavailable');return parseAutomaticNativeSnapshot(r.body,t,messageId);}
   catch{throw Error('automatic_native_snapshot_unavailable');}
  },
  submit:async(t:AutomaticWebTarget,messageId:string,commandId:string,content:string,fence:AutomaticNativeFence,showAiLabel=false):Promise<AutomaticSubmission>=>{
   try{
    if(typeof showAiLabel!=='boolean'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(commandId)||!content.trim()||content.length>4000)return {outcome:'rejected'};
    const input={...payload(t,messageId),command_id:commandId,content,fence,show_ai_label:showAiLabel};
    const response=await post('submit',input),r=object(response.body);
    if(!r)return {outcome:'uncertain'};
    if(!response.ok){
     // Only documented pre-action rejections are definite non-submissions.
     const rejected=keys(r,['error'])&&((response.status===401&&r.error==='unauthorized')||(response.status===422&&r.error==='invalid_payload'));
     return {outcome:rejected?'rejected':'uncertain'};
    }
    if(keys(r,['state','command_id'])&&r.command_id===commandId&&['rejected','state_changed'].includes(String(r.state)))return {outcome:'rejected'};
    if(!keys(r,['state','command_id','account_id','conversation_id','inbox_id','contact_id','source_message_id','message_id','content_sha256'])||
     r.state!=='accepted'||r.command_id!==commandId||!matchesTarget(r,t,messageId)||!validId(r.message_id)||r.content_sha256!==hash(content))return {outcome:'uncertain'};
    return {outcome:'accepted',receipt:Object.freeze({provider:'web_chat',acknowledged:true,providerMessageId:r.message_id})};
   }catch{return {outcome:'uncertain'};}
  }
 };
}
