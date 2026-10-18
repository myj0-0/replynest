import {activityGatewayFetch} from '../../../../../lib/activity-gateway-fetch';
import {NextRequest,NextResponse} from 'next/server';
import {fetchConsoleSession,gatewayUrl,hasValidOrigin,sessionToken} from '../../../../../lib/console-session';
import {randomUUID} from 'node:crypto';
import {readAttemptHeader,safeReadAttempt,safeReadTiming} from '../../../../../lib/workbench-read-diagnostics';
export async function POST(request:NextRequest,context:{params:Promise<{id:string}>}){
 const started=performance.now(),attempt=safeReadAttempt(request.headers.get(readAttemptHeader))??randomUUID();
 const timings:Record<string,number>={};let stage='origin',upstreamTiming='',upstreamRequest:string|undefined;
 const json=(body:unknown,status:number)=>{
  timings.console=Math.round(performance.now()-started);
  const serverTiming=[...Object.entries(timings).map(([key,ms])=>`${key};dur=${ms}`),upstreamTiming].filter(Boolean).join(', ');
  console.info(JSON.stringify({event:'workbench_read_console',attempt_id:attempt,request_id:upstreamRequest??null,status,stage,timings_ms:timings,upstream_timing:upstreamTiming,client_aborted:request.signal.aborted}));
  return NextResponse.json(body,{status,headers:{'cache-control':'private, no-store',[readAttemptHeader]:attempt,'server-timing':serverTiming}});
 };
 if(!hasValidOrigin(request)||request.headers.get('x-replynest-action')!=='workbench-read-v1'||['same-site','cross-site'].includes(request.headers.get('sec-fetch-site')??''))return json({error:{code:'invalid_origin'}},403);
 stage='session';const sessionStarted=performance.now();
 const token=await sessionToken(),session=token?await fetchConsoleSession():undefined;
 timings.session=Math.round(performance.now()-sessionStarted);
 if(!token||!session)return json({error:{code:'session_expired'}},401);
 if(session.impersonation)return json({error:{code:'console_session_required'}},403);
 if(!session.selected_tenant_id||request.headers.get('x-replynest-workspace')!==session.selected_tenant_id)return json({error:{code:'workspace_changed'}},409);
 const {id}=await context.params;
 if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)||request.nextUrl.search)return json({},404);
 if((request.headers.get('content-type')??'').split(';')[0]!=='application/json'||!request.body)return json({},400);
 stage='body';const bodyStarted=performance.now();
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;const timer=setTimeout(()=>void reader.cancel(),5000);
 try{
  for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>8192)return json({},413);chunks.push(p.value);}
  const bytes=new Uint8Array(size);let at=0;for(const p of chunks){bytes.set(p,at);at+=p.length;}
  const input=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
  if(!input||typeof input!=='object'||Object.keys(input).join(',')!=='message_ids'||!Array.isArray(input.message_ids)||!input.message_ids.length||input.message_ids.length>100||
   input.message_ids.some((v:unknown)=>typeof v!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v))||new Set(input.message_ids).size!==input.message_ids.length)return json({},400);
  timings.body=Math.round(performance.now()-bodyStarted);stage='gateway';const gatewayStarted=performance.now();
  try{
   const r=await activityGatewayFetch(gatewayUrl(`/api/v1/conversations/${id}/read`),{method:'POST',body:JSON.stringify(input),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(7000),
    headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-replynest-workspace':session.selected_tenant_id,[readAttemptHeader]:attempt}});
   upstreamTiming=safeReadTiming(r.headers.get('server-timing'));const result=await r.json();upstreamRequest=safeReadAttempt(result.request_id);
   timings.gateway_roundtrip=Math.round(performance.now()-gatewayStarted);stage='completed';return json(result,r.status);
  }finally{timings.gateway_roundtrip=Math.round(performance.now()-gatewayStarted);}
 }catch{return json({error:{code:'workbench_read_unavailable'}},503);}
 finally{clearTimeout(timer);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
