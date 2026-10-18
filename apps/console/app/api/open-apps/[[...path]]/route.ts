import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from 'next/server';
import { gatewayUrl, hasValidOrigin, sessionToken } from '../../../../lib/console-session';
async function forward(request:NextRequest,context:{params:Promise<{path?:string[]}>}){
  if(request.method==='POST'&&!hasValidOrigin(request))return NextResponse.json({error:{code:'forbidden'}},{status:403});
  const token=await sessionToken();if(!token)return NextResponse.json({error:{code:'unauthorized'}},{status:401});
  const {path=[]}=await context.params;
  if(path.length>2||path.some(p=>!/^[a-z0-9-]{1,64}$/i.test(p)))return NextResponse.json({error:{code:'not_found'}},{status:404});
  try{
    const body=request.method==='POST'?await request.text():undefined;
    if(body&&Buffer.byteLength(body)>20000)return NextResponse.json({error:{code:'request_too_large'}},{status:413});
    const r=await activityGatewayFetch(gatewayUrl(`/api/v1/open-apps${path.length?'/'+path.join('/'):''}`),{method:request.method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body,cache:'no-store',signal:AbortSignal.timeout(15000)});
    return NextResponse.json(await r.json(),{status:r.status,headers:{'Cache-Control':'no-store'}});
  }catch{return NextResponse.json({error:{code:'open_platform_unavailable'}},{status:503});}
}
export const GET=forward;
export const POST=forward;
