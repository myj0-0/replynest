import {NextRequest,NextResponse} from 'next/server';
import {activityGatewayFetch} from '../../../../lib/activity-gateway-fetch';
import {gatewayUrl,hasValidOrigin,sessionToken} from '../../../../lib/console-session';
export async function POST(req:NextRequest){
 if(!hasValidOrigin(req))return NextResponse.json({error:{code:'document_forbidden'}},{status:403});const token=await sessionToken();if(!token)return NextResponse.json({error:{code:'document_forbidden'}},{status:401});
 const body=await req.text();if(new TextEncoder().encode(body).length>900000)return NextResponse.json({error:{code:'document_invalid'}},{status:413});
 try{const r=await activityGatewayFetch(gatewayUrl('/api/v1/ai/knowledge/managed'),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':req.headers.get('idempotency-key')??''},body,signal:AbortSignal.timeout(10000),cache:'no-store'});return NextResponse.json(await r.json(),{status:r.status,headers:{'cache-control':'no-store'}});}catch{return NextResponse.json({error:{code:'document_outcome_unconfirmed'}},{status:503});}
}
