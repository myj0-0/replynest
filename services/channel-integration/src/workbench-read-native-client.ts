import {createHash,createHmac,randomBytes} from 'node:crypto';
import {parseUniqueReceptionJson} from './reception-history-native-client.js';
export type WorkbenchReadRequest={account_id:string;native_actor_id:string;operation:'stats'|'mark';conversation_ids:string[];message_ids?:string[]};
export type WorkbenchReadCount={conversation_id:string;unread_count:number;capped:boolean};
const path='/internal/saas_sso/workbench_read/control';
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
export function validateWorkbenchRead(input:WorkbenchReadRequest){
 const fields=['account_id','native_actor_id','operation','conversation_ids',...(input?.operation==='mark'?['message_ids']:[])].sort().join(',');
 if(!input||Object.keys(input).sort().join(',')!==fields||!id(input.account_id)||!id(input.native_actor_id)||!['stats','mark'].includes(input.operation)||
  !Array.isArray(input.conversation_ids)||!input.conversation_ids.length||input.conversation_ids.length>100||input.conversation_ids.some(v=>!id(v))||
  new Set(input.conversation_ids).size!==input.conversation_ids.length||input.operation==='mark'&&(!Array.isArray(input.message_ids)||!input.message_ids.length||input.message_ids.length>100||
   input.message_ids.some(v=>!id(v))||new Set(input.message_ids).size!==input.message_ids.length||input.conversation_ids.length!==1))throw Error('workbench_read_invalid');
}
export function parseWorkbenchRead(value:unknown,input:WorkbenchReadRequest,body:string):WorkbenchReadCount[]{
 validateWorkbenchRead(input);
 const v=value as Record<string,unknown>;
 if(!v||typeof v!=='object'||Object.keys(v).sort().join(',')!=='account_id,counts,operation,request_sha256'||v.account_id!==input.account_id||v.operation!==input.operation||
  v.request_sha256!==createHash('sha256').update(body).digest('hex')||!Array.isArray(v.counts)||v.counts.length!==input.conversation_ids.length)throw Error('workbench_read_unavailable');
 const seen=new Set<string>();
 return v.counts.map(row=>{
  if(!row||typeof row!=='object'||Object.keys(row).sort().join(',')!=='capped,conversation_id,unread_count'||!input.conversation_ids.includes(row.conversation_id)||seen.has(row.conversation_id)||
   !Number.isInteger(row.unread_count)||row.unread_count<0||row.unread_count>1000||typeof row.capped!=='boolean'||row.capped&&row.unread_count!==1000)throw Error('workbench_read_unavailable');
  seen.add(row.conversation_id);return row;
 });
}
export function createWorkbenchReadNativeClient(options:{origin:string;secret:string;fetcher?:typeof fetch}){
 const origin=new URL(options.origin);
 if(!['http:','https:'].includes(origin.protocol)||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash||
  Buffer.byteLength(options.secret)<32||Buffer.byteLength(options.secret)>65536||/[\0\r\n]/.test(options.secret))throw Error('workbench_read_config_invalid');
 return {control:async(input:WorkbenchReadRequest)=>{
  validateWorkbenchRead(input);const body=JSON.stringify(input),stamp=String(Date.now()),nonce=randomBytes(16).toString('hex');
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('workbench_read_unavailable'));},2000);});
  try{return await Promise.race([(async()=>{
   const r=await (options.fetcher??fetch)(origin.origin+path,{method:'POST',redirect:'error',signal:controller.signal,headers:{'content-type':'application/json',accept:'application/json','x-forwarded-proto':'https',
    'x-automatic-timestamp':stamp,'x-automatic-nonce':nonce,'x-automatic-signature':createHmac('sha256',options.secret).update(`${path}\n${stamp}\n${nonce}\n${body}`).digest('hex')},body});
   if(!r.ok||!r.body)throw Error('workbench_read_unavailable');const reader=r.body.getReader(),parts:Uint8Array[]=[];let size=0;
   const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
   try{for(;;){if(controller.signal.aborted)throw Error('workbench_read_unavailable');const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>32768)throw Error('workbench_read_unavailable');parts.push(p.value);}}
   finally{controller.signal.removeEventListener('abort',cancel);cancel();reader.releaseLock();}
   return parseWorkbenchRead(parseUniqueReceptionJson(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(parts))),input,body);
  })(),deadline]);}finally{clearTimeout(timer);controller.abort();}
 }};
}
