import {activityGatewayFetch} from "./activity-gateway-fetch";
import {NextRequest,NextResponse} from 'next/server';
import {fetchConsoleSession,gatewayUrl,sessionToken} from './console-session';
import {personalizationMessages,parsePersonalizationView} from './reception-personalization';
import {historyJobMessages,parseHistoryJobsPage} from './reception-history-jobs';
const messages={...personalizationMessages,...historyJobMessages};
function error(code:string,status:number){return NextResponse.json({error:{code,message:messages[code]??messages.personalization_result_uncertain}},{status,headers:{'cache-control':'no-store',...(status===429?{'retry-after':'60'}:{})}});}
async function bounded(stream:ReadableStream<Uint8Array>|null,max:number){
 if(!stream)throw Error('missing_body');const reader=stream.getReader();const parts:Uint8Array[]=[];let size=0,expired=false;
 const timer=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>{});},7000);
 try{for(;;){const {value,done}=await reader.read();if(expired)throw Error('body_timeout');if(done)break;size+=value.length;if(size>max)throw Error('body_too_large');parts.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 }catch(e){await reader.cancel().catch(()=>{});throw e;}finally{clearTimeout(timer);reader.releaseLock();}
}
export async function proxyReceptionPersonalization(req:NextRequest,segments:string[]=[]){
 const path=segments.join('/'),get=req.method==='GET';
 const jobs=path==='knowledge-jobs';
 if(!jobs&&req.nextUrl.search||(get?path!==''&&!jobs:req.method!=='POST'||!['settings','history-grant','public-label','knowledge-jobs'].includes(path)))return error('method_not_allowed',405);
 if(jobs&&req.nextUrl.search){const p=req.nextUrl.searchParams;
  if(!get||[...p.keys()].some(k=>!['cursor','requestId'].includes(k))||p.getAll('cursor').length>1||p.getAll('requestId').length>1||p.has('cursor')&&p.has('requestId')||
   p.has('cursor')&&!/^[A-Za-z0-9_-]{1,256}$/.test(p.get('cursor')??'')||p.has('requestId')&&!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(p.get('requestId')??''))return error('history_query_invalid',400);
 }
 if(!get){try{
  if(req.headers.get('origin')!==new URL(process.env.CONSOLE_PUBLIC_ORIGIN??'').origin||req.headers.get('x-replynest-action')!=='reception-personalization-v1'||
   ['cross-site','same-site'].includes(req.headers.get('sec-fetch-site')??''))return error('invalid_origin',403);
 }catch{return error('invalid_origin',403);}}
 const token=await sessionToken();if(!token||!/^[a-f0-9]{64}$/.test(token))return error('unauthorized',401);
 const session=await fetchConsoleSession();if(!session)return error('unauthorized',401);
 const workspace=session.workspaces.find(w=>w.tenant_id===session.selected_tenant_id);
 if(!workspace||workspace.role!=='tenant_admin'||session.impersonation)return error('administrator_session_required',403);
 if(req.headers.get('x-replynest-workspace')!==workspace.tenant_id)return error('workspace_changed',409);
 let body:string|undefined;
 if(!get){
  if((req.headers.get('content-type')??'').split(';')[0].trim()!=='application/json')return error('invalid_payload',400);
  try{body=await bounded(req.body,4096);JSON.parse(body);}catch(e){const large=e instanceof Error&&e.message==='body_too_large';return error(large?'body_too_large':'invalid_payload',large?413:400);}
 }
 try{
  const r=await activityGatewayFetch(gatewayUrl('/api/v1/reception-personalization'+(path?'/'+path:'')+(jobs?req.nextUrl.search:'')),{method:get?'GET':'POST',
   headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-replynest-workspace':workspace.tenant_id},body,
   cache:'no-store',redirect:'error',signal:AbortSignal.timeout(7000)});
  const result=JSON.parse(await bounded(r.body,65536));
  if(!r.ok){const code=typeof result?.error?.code==='string'&&Object.hasOwn(messages,result.error.code)?result.error.code:'personalization_result_uncertain';return error(code,r.status);}
  return NextResponse.json({data:jobs?parseHistoryJobsPage(result?.data):parsePersonalizationView(result?.data)},{headers:{'cache-control':'no-store'}});
 }catch{return error('personalization_result_uncertain',503);}
}
