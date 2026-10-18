import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from 'next/server';
import { gatewayUrl, hasValidOrigin, sessionToken } from '../../../../lib/console-session';

async function forward(request: NextRequest, method: 'GET'|'POST') {
  if (method==='POST' && !hasValidOrigin(request)) return NextResponse.json({error:{code:'forbidden'}},{status:403});
  const token=await sessionToken();
  if (!token) return NextResponse.json({error:{code:'unauthorized'}},{status:401});
  try {
    const body=method==='POST'?await request.text():undefined;
    if (body && body.length>2048) return NextResponse.json({error:{code:'invalid_checkout'}},{status:400});
    const response=await activityGatewayFetch(gatewayUrl('/api/v1/billing/checkout'),{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body,cache:'no-store',signal:AbortSignal.timeout(15000)});
    return NextResponse.json(await response.json(),{status:response.status,headers:{'Cache-Control':'no-store'}});
  } catch { return NextResponse.json({error:{code:'checkout_unavailable'}},{status:503}); }
}
export const GET=(request:NextRequest)=>forward(request,'GET');
export const POST=(request:NextRequest)=>forward(request,'POST');
