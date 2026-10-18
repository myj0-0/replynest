import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { gatewayUrl, hasValidOrigin, sessionToken } from "../../../../../lib/console-session";
export async function POST(request:NextRequest) {
  if(!hasValidOrigin(request))return NextResponse.json({},{status:403});
  const token=await sessionToken();if(!token)return NextResponse.json({},{status:401});
  const body=await request.text();if(body.length>4096)return NextResponse.json({},{status:413});
  try {
    const response=await activityGatewayFetch(gatewayUrl("/api/v1/browser-push/subscriptions/status"),{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body,cache:"no-store",signal:AbortSignal.timeout(10000)});
    return new NextResponse(await response.text(),{status:response.status,headers:{"content-type":"application/json","cache-control":"private, no-store"}});
  } catch {return NextResponse.json({},{status:503});}
}
