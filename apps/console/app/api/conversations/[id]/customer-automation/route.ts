import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import {NextRequest,NextResponse} from 'next/server';
import {fetchConsoleSession,gatewayUrl,hasValidOrigin,sessionToken} from '../../../../../lib/console-session';
const json=(body:unknown,status:number)=>NextResponse.json(body,{status,headers:{'cache-control':'private, no-store'}});
async function proxy(request:NextRequest,context:{params:Promise<{id:string}>}){
 const mutation=request.method==='PATCH';
 if(mutation&&(!hasValidOrigin(request)||request.headers.get('x-replynest-action')!=='customer-automation-v1'||['same-site','cross-site'].includes(request.headers.get('sec-fetch-site')??'')))return json({error:{code:'invalid_origin'}},403);
 const token=await sessionToken(),session=token?await fetchConsoleSession():undefined;
 if(!token||!session)return json({error:{code:'session_expired'}},401);
 if(session.impersonation)return json({error:{code:'console_session_required'}},403);
 if(!session.selected_tenant_id||request.headers.get('x-replynest-workspace')!==session.selected_tenant_id)return json({error:{code:'workspace_changed'}},409);
 const {id}=await context.params;
 if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)||request.nextUrl.search)return json({},404);
 try{
  let body:string|undefined;
  if(mutation){
   if((request.headers.get('content-type')??'').split(';')[0]!=='application/json')return json({},400);
   if(!request.body)return json({},400);
   const reader=request.body.getReader();let size=0;const chunks:Uint8Array[]=[];
   const timer=setTimeout(()=>void reader.cancel(),5000);
   try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1024)return json({},413);chunks.push(part.value);}
    const joined=new Uint8Array(size);let offset=0;for(const part of chunks){joined.set(part,offset);offset+=part.length;}
    body=JSON.stringify(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(joined)));
   }finally{clearTimeout(timer);await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  const r=await activityGatewayFetch(gatewayUrl(`/api/v1/conversations/${id}/customer-automation`),{method:request.method,body,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(7000),
   headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-replynest-workspace':session.selected_tenant_id}});
  return json(await r.json(),r.status);
 }catch{return json({error:{code:'customer_automation_unavailable'}},503);}
}
export const GET=proxy;
export const PATCH=proxy;
