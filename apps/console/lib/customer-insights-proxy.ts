import {NextRequest,NextResponse} from 'next/server';
import {activityGatewayFetch} from './activity-gateway-fetch';
import {sessionToken,fetchConsoleSession,gatewayUrl} from './console-session';
import {insightMessages,parseInsightsSettings,parseInsightsTopics,parseInsightsProfile,parseInsightsProfiles,parseInsightsBilling} from './customer-insights';
function error(code:string,status:number){return NextResponse.json({error:{code,message:insightMessages[code]??insightMessages.insights_result_uncertain}},{status,headers:{'cache-control':'no-store'}});}
async function bounded(stream:ReadableStream<Uint8Array>|null,max:number){
 if(!stream)throw Error('invalid_payload');const reader=stream.getReader();const parts:Uint8Array[]=[];let size=0,expired=false;
 const timer=setTimeout(()=>{expired=true;void reader.cancel().catch(()=>{});},5000);
 try{for(;;){const {value,done}=await reader.read();if(expired)throw Error('body_timeout');if(done)break;size+=value.length;if(size>max)throw Error('body_too_large');parts.push(value);}
  const all=new Uint8Array(size);let pos=0;for(const p of parts){all.set(p,pos);pos+=p.length;}return new TextDecoder('utf-8',{fatal:true}).decode(all);
 }catch(e){await reader.cancel().catch(()=>{});throw e;}finally{clearTimeout(timer);reader.releaseLock();}
}
export async function proxyCustomerInsights(req:NextRequest,segments:string[]){
 if(process.env.CONSOLE_CUSTOMER_INSIGHTS_ENABLED!=='true')return error('insights_disabled',404);
 const path=segments.join('/'),get=req.method==='GET';
 const conversation=/^conversations\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(path);
 const billing=path==='billing',reconcile=/^billing\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/reconcile$/.test(path);
 if((req.nextUrl.search&&!(billing&&[...req.nextUrl.searchParams.keys()].every(k=>k==='before')&&req.nextUrl.searchParams.getAll('before').length===1&&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(req.nextUrl.searchParams.get('before')??'')))||
  !((path==='settings'||conversation)&&(get||req.method==='POST')||(['topics','profiles'].includes(path)||billing)&&get||reconcile&&req.method==='POST'))return error('method_not_allowed',405);
 if(!get){try{
  if(req.headers.get('origin')!==new URL(process.env.CONSOLE_PUBLIC_ORIGIN??'').origin||req.headers.get('x-replynest-action')!=='customer-insights-v1'||
   ['cross-site','same-site'].includes(req.headers.get('sec-fetch-site')??''))return error('invalid_origin',403);
 }catch{return error('invalid_origin',403);}}
 const token=await sessionToken();if(!token||!/^[a-f0-9]{64}$/.test(token))return error('unauthorized',401);
 const session=await fetchConsoleSession();if(!session)return error('unauthorized',401);
 const workspace=session.workspaces.find(w=>w.tenant_id===session.selected_tenant_id);
 if(!workspace||session.impersonation||(path==='settings'||billing||reconcile)&&workspace.role!=='tenant_admin'||['topics','profiles'].includes(path)&&workspace.role==='agent')return error('insights_admin_required',403);
 if(req.headers.get('x-replynest-workspace')!==workspace.tenant_id)return error('workspace_changed',409);
 let body:string|undefined;
 if(!get){if((req.headers.get('content-type')??'').split(';')[0].trim()!=='application/json')return error('invalid_payload',400);
  try{body=await bounded(req.body,conversation?12288:4096);}catch(e){const code=e instanceof Error?e.message:'';return error(Object.hasOwn(insightMessages,code)?code:'invalid_payload',code==='body_too_large'?413:400);}}
 try{
  const r=await activityGatewayFetch(gatewayUrl('/api/v1/customer-insights/'+path+(billing?req.nextUrl.search:'')),{method:get?'GET':'POST',headers:{authorization:`Bearer ${token}`,
   'content-type':'application/json','x-replynest-workspace':workspace.tenant_id},body,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(7000)});
  const result=JSON.parse(await bounded(r.body,32768));
  if(!r.ok){const code=typeof result?.error?.code==='string'&&Object.hasOwn(insightMessages,result.error.code)?result.error.code:'insights_result_uncertain';return error(code,r.status);}
  if(reconcile){if(typeof result?.data?.repeated!=='boolean')throw Error('insights_result_uncertain');return NextResponse.json({data:{repeated:result.data.repeated}},{headers:{'cache-control':'no-store'}});}
  return NextResponse.json({data:billing?parseInsightsBilling(result.data):conversation?parseInsightsProfile(result.data):path==='settings'?parseInsightsSettings(result.data):path==='profiles'?parseInsightsProfiles(result.data):parseInsightsTopics(result.data)},{headers:{'cache-control':'no-store'}});
 }catch{return error('insights_result_uncertain',503);}
}
