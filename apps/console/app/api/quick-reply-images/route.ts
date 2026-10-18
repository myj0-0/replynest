import {NextRequest,NextResponse} from 'next/server';
import {activityGatewayFetch} from '../../../lib/activity-gateway-fetch';
import {fetchConsoleSession,gatewayUrl,hasValidOrigin,sessionToken} from '../../../lib/console-session';
export const dynamic='force-dynamic';
const json=(body:unknown,status:number)=>NextResponse.json(body,{status,headers:{'cache-control':'private, no-store'}});
export async function POST(request:NextRequest){
 if(!hasValidOrigin(request))return json({error:{code:'invalid_origin'}},403);
 const token=await sessionToken(),session=token?await fetchConsoleSession():undefined;
 if(!token||!session)return json({error:{code:'session_expired'}},401);
 const workspace=session.workspaces.find(w=>w.tenant_id===session.selected_tenant_id);
 if(session.impersonation||!workspace||!['tenant_admin','supervisor'].includes(workspace.role))return json({error:{code:'manager_required'}},403);
 try{
  const form=await request.formData(),file=form.get('file');
  if(!(file instanceof File)||!file.size||file.size>2*1024*1024)return json({error:{message:'请选择不超过 2 MiB 的 JPEG、PNG 或 GIF 图片'}},400);
  const forwarded=new FormData();forwarded.set('file',file,file.name);
  const r=await activityGatewayFetch(gatewayUrl('/api/v1/quick-reply-images'),{method:'POST',headers:{authorization:`Bearer ${token}`,'x-replynest-workspace':workspace.tenant_id},body:forwarded,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(45000)});
  return json(await r.json(),r.status);
 }catch{return json({error:{code:'image_service_unavailable',message:'图片安全处理服务暂不可用，请稍后重试'}},503);}
}
