import {NextRequest,NextResponse} from 'next/server';
import {activityGatewayFetch} from '../../../../../lib/activity-gateway-fetch';
import {fetchConsoleSession,gatewayUrl,hasValidOrigin,sessionToken} from '../../../../../lib/console-session';
export async function POST(request:NextRequest,context:{params:Promise<{id:string}>}){
 const json=(body:unknown,status:number)=>NextResponse.json(body,{status,headers:{'cache-control':'private, no-store'}});
 if(!hasValidOrigin(request))return json({error:{code:'invalid_origin'}},403);
 const token=await sessionToken(),session=token?await fetchConsoleSession():undefined;
 if(!token||!session)return json({error:{code:'session_expired'}},401);
 if(session.impersonation||!session.selected_tenant_id)return json({error:{code:'console_session_required'}},403);
 const {id}=await context.params;if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))return json({},404);
 try{
  const body=await request.json();
  const r=await activityGatewayFetch(gatewayUrl(`/api/v1/quick-replies/${id}/prepare-image`),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':request.headers.get('idempotency-key')??'','x-replynest-workspace':session.selected_tenant_id},body:JSON.stringify(body),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(45000)});
  return json(await r.json(),r.status);
 }catch{return json({error:{code:'image_prepare_unavailable',message:'图片准备结果未确认；未发送客户消息，请稍后重试'}},503);}
}
