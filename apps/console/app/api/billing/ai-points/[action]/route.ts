import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import {NextRequest,NextResponse} from 'next/server';
import {gatewayUrl,hasValidOrigin,sessionToken} from '../../../../../lib/console-session';
export async function POST(request:NextRequest,{params}:{params:Promise<{action:string}>}){
 const {action}=await params;if(!['purchase','refund'].includes(action))return NextResponse.json({error:{code:'not_found'}},{status:404});
 if(!hasValidOrigin(request))return NextResponse.json({error:{code:'forbidden'}},{status:403});
 const token=await sessionToken();if(!token)return NextResponse.json({error:{code:'unauthorized'}},{status:401});
 try{const body=await request.text();if(body.length>2048)return NextResponse.json({error:{code:'invalid_request'}},{status:400});
 const r=await activityGatewayFetch(gatewayUrl(`/api/v1/billing/ai-points/${action}`),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body,cache:'no-store',signal:AbortSignal.timeout(15000)});
 return NextResponse.json(await r.json(),{status:r.status,headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:{code:'ai_points_unavailable'}},{status:503});}
}
