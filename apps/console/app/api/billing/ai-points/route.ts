import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from 'next/server';
import { gatewayUrl,sessionToken } from '../../../../lib/console-session';
export async function GET(request:NextRequest){
 const token=await sessionToken();
 if(!token)return NextResponse.json({error:{code:'unauthorized'}},{status:401});
 const view=request.nextUrl.searchParams.get('view');
 if(view&&!['summary','full'].includes(view))return NextResponse.json({error:{code:'invalid_request'}},{status:400});
 try{
  const response=await activityGatewayFetch(gatewayUrl('/api/v1/billing/ai-points'+(view?'?view='+view:'')),{headers:{authorization:`Bearer ${token}`},cache:'no-store',signal:AbortSignal.timeout(15000)});
  return NextResponse.json(await response.json(),{status:response.status,headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:{code:'ai_points_unavailable'}},{status:503});}
}
