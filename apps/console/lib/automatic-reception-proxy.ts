import {activityGatewayFetch} from "./activity-gateway-fetch";
import {NextRequest,NextResponse} from 'next/server';
import {fetchConsoleSession,gatewayUrl,sessionToken} from './console-session';
import {automaticMessages} from './automatic-reception';
const uuid='[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}';
function error(code:string,status:number){return NextResponse.json({error:{code,message:automaticMessages[code]??automaticMessages.management_result_uncertain}},{status,headers:{'cache-control':'no-store'}});}
async function boundedText(stream:ReadableStream<Uint8Array>|null,max:number){
 if(!stream)throw Error();const reader=stream.getReader(),parts:Uint8Array[]=[];let size=0;
 let expired=false;const timer=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>{});},7000);
 try{for(;;){const {value,done}=await reader.read();if(expired)throw Error('body_timeout');if(done)break;size+=value.length;if(size>max)throw Error('body_too_large');parts.push(value);}
  const out=new Uint8Array(size);let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return new TextDecoder('utf-8',{fatal:true}).decode(out);
 }catch(e){await reader.cancel().catch(()=>{});throw e;}finally{clearTimeout(timer);reader.releaseLock();}
}
/** Whitelisted routes only; strict same-origin/custom header for mutations. No URL/body-selected tenant. */
export async function proxyAutomaticReception(request:NextRequest,segments:string[]=[]){
 const path=segments.join('/'),get=request.method==='GET';
 if(get?!['','tasks','sources'].includes(path):request.method!=='POST'||!['grant','wechat-grant','answers'].includes(path)&&!new RegExp(`^answers/${uuid}/(replace|approve|disable)$`).test(path))return error('method_not_allowed',405);
 if(!get){
  try{if(request.headers.get('origin')!==new URL(process.env.CONSOLE_PUBLIC_ORIGIN??'').origin||
   request.headers.get('x-replynest-action')!=='automatic-reception-v1'||['cross-site','same-site'].includes(request.headers.get('sec-fetch-site')??''))return error('invalid_origin',403);
  }catch{return error('invalid_origin',403);}
 }
 const token=await sessionToken();if(!token||!/^[a-f0-9]{64}$/.test(token))return error('unauthorized',401);
 const session=await fetchConsoleSession(),workspace=session?.workspaces.find(w=>w.tenant_id===session.selected_tenant_id);
 if(!session)return error('unauthorized',401);
 if(!workspace||workspace.role!=='tenant_admin'||session.impersonation)return error('administrator_session_required',403);
 if(request.headers.get('x-replynest-workspace')!==workspace.tenant_id)return error('workspace_changed',409);
 let query='';
 if(get){
  const params=request.nextUrl.searchParams;
  if([...params.keys()].some(k=>!['limit','after'].includes(k))||params.getAll('limit').length>1||params.getAll('after').length>1||
   !/^([1-9]|1\d|2[0-5])$/.test(params.get('limit')??'10')||(params.get('after')?.length??0)>200)return error('invalid_payload',400);
  query='?'+params.toString();
 }else if(request.nextUrl.search)return error('invalid_payload',400);
 let body:string|undefined;
 if(!get){
  if((request.headers.get('content-type')??'').split(';')[0].trim()!=='application/json')return error('invalid_payload',400);
  try{body=await boundedText(request.body,32768);JSON.parse(body);}catch(e){const large=e instanceof Error&&e.message==='body_too_large';return error(large?'body_too_large':'invalid_payload',large?413:400);}
 }
 try{
  const upstream=await activityGatewayFetch(gatewayUrl('/api/v1/automatic-reception/management'+(path?'/'+path:'')+query),{
   method:get?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-replynest-workspace':workspace.tenant_id},
   body,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(7000)});
  const result=JSON.parse(await boundedText(upstream.body,1048576));
  if(!upstream.ok){const code=typeof result?.error?.code==='string'&&Object.hasOwn(automaticMessages,result.error.code)?result.error.code:'management_result_uncertain';return error(code,upstream.status);}
  if(!result?.data||typeof result.data!=='object')return error('management_result_uncertain',503);
  return NextResponse.json({data:result.data},{headers:{'cache-control':'no-store'}});
 }catch{return error('management_result_uncertain',503);}
}
