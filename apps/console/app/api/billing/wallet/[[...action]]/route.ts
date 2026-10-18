import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { NextRequest,NextResponse } from 'next/server';
import { gatewayUrl,hasValidOrigin,sessionToken } from '../../../../../lib/console-session';
async function forward(request:NextRequest,context:{params:Promise<{action?:string[]}>}){
 const {action=[]}=await context.params;
 if(action.length>1||action.length===1&&!['topup','purchase','requests','plan-quote','plan-change'].includes(action[0])||request.method==='GET'&&action.length||request.method==='POST'&&!action.length)return NextResponse.json({error:{code:'not_found'}},{status:404});
 if(request.method==='POST'&&!hasValidOrigin(request))return NextResponse.json({error:{code:'forbidden'}},{status:403});
 const token=await sessionToken();if(!token)return NextResponse.json({error:{code:'unauthorized'}},{status:401});
 try{const body=request.method==='POST'?await request.text():undefined;if(body&&body.length>2048)return NextResponse.json({error:{code:'invalid_request'}},{status:400});
 const view=request.method==='GET'?request.nextUrl.searchParams.get('view'):null;
 if(view&&!['full','summary','purchases','requests'].includes(view))return NextResponse.json({error:{code:'invalid_request'}},{status:400});
 const r=await activityGatewayFetch(gatewayUrl(`/api/v1/billing/wallet${action.length?'/'+action[0]:''}${view?'?view='+view:''}`),{method:request.method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body,cache:'no-store',signal:AbortSignal.timeout(15000)});
 return NextResponse.json(await r.json(),{status:r.status,headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:{code:'wallet_unavailable'}},{status:503});}
}
export const GET=forward;export const POST=forward;
