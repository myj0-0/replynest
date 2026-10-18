import {NextRequest,NextResponse} from 'next/server';
import {activityGatewayFetch} from '../../../../../lib/activity-gateway-fetch';
import {gatewayUrl,hasValidOrigin,sessionToken} from '../../../../../lib/console-session';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json=(body:unknown,status:number)=>NextResponse.json(body,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
export async function POST(request:NextRequest,context:{params:Promise<{id:string}>}){
  if(!hasValidOrigin(request))return json({error:{code:'invalid_origin'}},403);
  const token=await sessionToken();if(!token)return json({error:{code:'session_expired',message:'登录已失效'}},401);
  const {id}=await context.params,key=request.headers.get('idempotency-key')?.trim()??'';
  let input:any;try{input=await request.json();}catch{}
  if(!uuid.test(id)||key.length<8||key.length>128||!input||Array.isArray(input)||Object.keys(input).length!==1||!uuid.test(input.file_transfer_id??''))return json({error:{code:'invalid_media',message:'媒体发送参数不合法'}},400);
  try{
    const upstream=await activityGatewayFetch(gatewayUrl(`/api/v1/conversations/${id}/media`),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':key},
      body:JSON.stringify({file_transfer_id:input.file_transfer_id}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(90000)});
    return json(await upstream.json(),upstream.status);
  }catch{return json({error:{code:'send_outcome_uncertain',message:'媒体发送结果尚未确认，请勿重复发送并联系管理员核查'}},503);}
}
