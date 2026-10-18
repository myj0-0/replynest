import {createHash,createHmac,randomBytes} from 'node:crypto';
import {automaticWeChatTargetPayload,type AutomaticWeChatNativeTarget} from './automatic-wechat-native-client.js';
// Old acknowledged envelopes remain projectable, but cannot be used by the send client.
export type AutomaticWeChatHistoryTarget=Omit<AutomaticWeChatNativeTarget,'customerId'>&{customerId?:string};
export function automaticWeChatHistoryTargetPayload(t:AutomaticWeChatHistoryTarget,messageId:string){
 const p=automaticWeChatTargetPayload({...t,customerId:t.customerId??'00000000-0000-4000-8000-000000000000'},messageId);
 if(t.customerId===undefined){const {customer_id,...legacy}=p;return legacy;}return p;
}
export type AutomaticWeChatHistoryRequest=Readonly<{
 target:AutomaticWeChatHistoryTarget;messageId:string;commandId:string;content:string;providerAcceptedAt:string;
}>;
export type AutomaticWeChatHistoryResult={outcome:'recorded';messageId:string}|{outcome:'rejected'|'uncertain'};
const keys=(v:Record<string,unknown>,k:string[])=>Object.keys(v).sort().join(',')===[...k].sort().join(',');
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const id=(v:unknown)=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const time=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(v)&&
 Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,23)===v.slice(0,23);
const micro=(v:string)=>v.slice(0,-1).padEnd(26,'0')+'Z';

/** Server-only history RPC. Fixed native route, signed exact body, no WeChat
 * credentials/provider port. Replaying the SAME acknowledgement records history
 * idempotently, never renews a send permit. A native message ID is not a provider ID.
 */
export function createAutomaticWeChatHistoryClient(options:{origin:string;secret:string;enabled?:()=>boolean;fetcher?:typeof fetch;now?:()=>number}){
 let origin:URL;try{origin=new URL(options.origin);}catch{throw Error('invalid_automatic_wechat_history_config');}
 if(!['http:','https:'].includes(origin.protocol)||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash||
  typeof options.secret!=='string'||Buffer.byteLength(options.secret)<32||Buffer.byteLength(options.secret)>65536||/[\0\r\n]/.test(options.secret))throw Error('invalid_automatic_wechat_history_config');
 const enabled=options.enabled??(()=>false),fetcher=options.fetcher??fetch,now=options.now??Date.now;
 return {project:async(request:AutomaticWeChatHistoryRequest):Promise<AutomaticWeChatHistoryResult>=>{
  if(!enabled())return {outcome:'rejected'};
  let timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();
  try{
   if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(request.commandId)||!time(request.providerAcceptedAt)||
    typeof request.content!=='string'||!request.content.trim()||Buffer.byteLength(request.content)>1800||request.content.includes('\0')||
    Buffer.from(request.content).toString('utf8')!==request.content)return {outcome:'rejected'};
   const target=automaticWeChatHistoryTargetPayload(request.target,request.messageId),command=request.commandId,content=request.content,accepted=micro(request.providerAcceptedAt);
   const input={...target,command_id:command,content,provider_accepted_at:accepted};
   const body=JSON.stringify(input),stamp=String(now()),nonce=randomBytes(16).toString('hex'),path='/internal/saas_sso/automatic_wechat/history';
   if(!/^\d{13}$/.test(stamp))return {outcome:'rejected'};
   const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('history_deadline'));},2000);});
   const operation=(async()=>{
    const r=await fetcher(origin.origin+path,{method:'POST',redirect:'error',signal:controller.signal,
     headers:{'content-type':'application/json',accept:'application/json','x-forwarded-proto':'https',
      'x-automatic-timestamp':stamp,'x-automatic-nonce':nonce,
      'x-automatic-signature':createHmac('sha256',options.secret).update(`${path}\n${stamp}\n${nonce}\n${body}`).digest('hex')},body});
    if(!r.body)throw Error();const reader=r.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
    let text:string;
    try{while(true){if(controller.signal.aborted)throw Error();const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>16384)throw Error();chunks.push(p.value);}
     text=new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks));
    }finally{controller.signal.removeEventListener('abort',cancel);cancel();reader.releaseLock();}
    const v=JSON.parse(text!) as Record<string,unknown>;
    if(!v||Array.isArray(v)||typeof v!=='object')throw Error();
    const names=[...text!.matchAll(/("(?:\\.|[^"\\])*")\s*:/g)].map(m=>JSON.parse(m[1]));
    if(names.length!==Object.keys(v).length||new Set(names).size!==names.length)throw Error();
    if(r.status!==200)return {outcome:'uncertain'} as const;
    if(keys(v,['state','command_id'])&&v.command_id===command&&['rejected','command_conflict','history_missing'].includes(String(v.state)))return {outcome:'rejected'} as const;
    if(!keys(v,['state','command_id','account_id','conversation_id','inbox_id','contact_id','source_message_id','message_id','provider','content_sha256','provider_accepted_at'])||
     v.state!=='recorded'||v.command_id!==command||v.account_id!==target.account_id||v.conversation_id!==target.conversation_id||
     v.inbox_id!==target.inbox_id||v.contact_id!==target.contact_id||v.source_message_id!==target.message_id||
     v.provider!==target.provider||v.content_sha256!==sha(content)||v.provider_accepted_at!==accepted||!id(v.message_id))throw Error();
    return {outcome:'recorded',messageId:v.message_id as string} as const;
   })();
   return await Promise.race([operation,deadline]);
  }catch{return {outcome:'uncertain'};}
  finally{if(timer)clearTimeout(timer);controller.abort();}
 }};
}
