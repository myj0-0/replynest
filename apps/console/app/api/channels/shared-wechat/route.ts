import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { gatewayUrl, hasValidOrigin, sessionToken } from "../../../../lib/console-session";
async function proxy(request: NextRequest) {
  if(request.method==="POST" && !hasValidOrigin(request))return NextResponse.json({error:{code:"invalid_origin"}},{status:403});
  const token=await sessionToken();if(!token)return NextResponse.json({},{status:401});
  try {
    const body=request.method==="POST"?await request.text():undefined;
    if(body && body.length>2048)return NextResponse.json({},{status:413});
    const result=await activityGatewayFetch(gatewayUrl("/api/v1/channels/shared-wechat"),{method:request.method,headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body,cache:"no-store",signal:AbortSignal.timeout(25000)});
    return NextResponse.json(await result.json(),{status:result.status,headers:{"cache-control":"private, no-store"}});
  } catch {return NextResponse.json({error:{code:"shared_operation_unconfirmed"}},{status:503});}
}
export const GET=proxy;
export const POST=proxy;
