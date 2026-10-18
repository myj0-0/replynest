import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from 'next/server';
import { gatewayUrl, hasValidOrigin, sessionToken } from '../../../../lib/console-session';

async function forward(request:NextRequest, context:{params:Promise<{path?:string[]}>}) {
  if(request.method==='POST' && !hasValidOrigin(request)) return NextResponse.json({error:{code:'forbidden'}},{status:403});
  const token = await sessionToken();
  if(!token) return NextResponse.json({error:{code:'unauthorized'}},{status:401});
  const {path=[]} = await context.params;
  if(path.length>2 || path.some(p=>!/^[a-z0-9-]{1,64}$/i.test(p))) return NextResponse.json({error:{code:'not_found'}},{status:404});
  try {
    const body = request.method==='POST' ? await request.text() : undefined;
    if(body && Buffer.byteLength(body)>32000) return NextResponse.json({error:{code:'request_too_large'}},{status:413});
    const cursor=path.length===1&&path[0]==='knowledge-options'?request.nextUrl.searchParams.get('cursor'):null;
    if(cursor&&cursor.length>1024)return NextResponse.json({error:{code:'invalid_cursor'}},{status:400});
    const query=cursor?'?'+new URLSearchParams({cursor}).toString():'';
    const response = await activityGatewayFetch(gatewayUrl(`/api/v1/extensions${path.length?'/'+path.join('/'):''}${query}`),{method:request.method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body,cache:'no-store',signal:AbortSignal.timeout(60000)});
    return NextResponse.json(await response.json(),{status:response.status,headers:{'Cache-Control':'no-store'}});
  } catch { return NextResponse.json({error:{code:'extensions_unavailable'}},{status:503}); }
}
export const GET=forward;
export const POST=forward;
