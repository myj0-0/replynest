import type {AutomaticInbound} from './automatic-reception-queue.js';
import {parseUniqueReceptionJson} from './reception-history-native-client.js';
/** Fixed server-owned conversation metadata read. One wall-clock deadline also
 * covers the body; abort alone is not sufficient for a stalled/injected stream. */
export function createCustomerInsightsProjectionReader(options:{origin:string;token:string;enabled?:()=>boolean;fetcher?:typeof fetch}){
 let origin:URL;try{origin=new URL(options.origin);}catch{throw Error('insights_projection_configuration_invalid');}
 if(!['http:','https:'].includes(origin.protocol)||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash||
  !options.token||options.token.length>65536||/[\0\r\n]/.test(options.token))throw Error('insights_projection_configuration_invalid');
 const enabled=options.enabled??(()=>false),fetcher=options.fetcher??fetch;
 return async(e:AutomaticInbound):Promise<unknown>=>{
  const id=(s:string)=>/^[1-9]\d{0,18}$/.test(s)&&BigInt(s)<=9223372036854775807n;
  if(!enabled()||![e.account,e.conversation].every(id))throw Error('insights_projection_unavailable');
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('insights_projection_unavailable'));},2000);});
   const operation=(async()=>{
    const r=await fetcher(`${origin.origin}/api/v1/accounts/${e.account}/conversations/${e.conversation}`,{headers:{api_access_token:options.token,accept:'application/json','x-forwarded-proto':'https'},redirect:'error',signal:controller.signal});
    if(!r.ok||!r.body)throw Error();const reader=r.body.getReader(),parts:Uint8Array[]=[];let size=0;
    const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
    try{
     for(;;){if(controller.signal.aborted)throw Error();const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>65536)throw Error();parts.push(p.value);}
     if(!enabled()||controller.signal.aborted)throw Error();return parseUniqueReceptionJson(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(parts)));
    }finally{controller.signal.removeEventListener('abort',cancel);cancel();reader.releaseLock();}
   })();return await Promise.race([operation,deadline]);
  }catch{throw Error('insights_projection_unavailable');}finally{if(timer)clearTimeout(timer);controller.abort();}
 };
}
