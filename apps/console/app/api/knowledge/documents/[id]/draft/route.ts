import {activityGatewayFetch} from "../../../../../../lib/activity-gateway-fetch";
import {NextRequest,NextResponse} from 'next/server';
import {gatewayUrl,hasValidOrigin,sessionToken} from '../../../../../../lib/console-session';
export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>}){
 if(!hasValidOrigin(req))return NextResponse.json({error:{code:'draft_forbidden'}},{status:403});
 const token=await sessionToken(),{id}=await params;
 if(!token)return NextResponse.json({error:{code:'draft_forbidden'}},{status:401});
 if(!/^[0-9a-f-]{36}$/i.test(id))return NextResponse.json({error:{code:'draft_not_found'}},{status:404});
 const body=await req.text();if(new TextEncoder().encode(body).length>900000)return NextResponse.json({error:{code:'draft_invalid'}},{status:413});
 try{const r=await activityGatewayFetch(gatewayUrl(`/api/v1/ai/knowledge/documents/${id}/draft`),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body,cache:'no-store',signal:AbortSignal.timeout(15000)});return NextResponse.json(await r.json(),{status:r.status,headers:{'Cache-Control':'no-store'}});}catch{return NextResponse.json({error:{code:'draft_unavailable'}},{status:503});}
}
