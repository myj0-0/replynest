import {NextRequest,NextResponse} from 'next/server';
import {activityGatewayFetch} from '../../../../../../../lib/activity-gateway-fetch';
import {gatewayUrl,hasValidOrigin,sessionToken} from '../../../../../../../lib/console-session';
async function proxy(req:NextRequest,{params}:{params:Promise<{id:string;part?:string[]}>}){
 if(req.method==='POST'&&!hasValidOrigin(req))return NextResponse.json({error:{code:'document_forbidden'}},{status:403});const token=await sessionToken();if(!token)return NextResponse.json({error:{code:'document_forbidden'}},{status:401});
 const {id,part=[]}=await params;if(!/^[0-9a-f-]{36}$/i.test(id)||part.length>1||(part.length&&part[0]!=='history')||part.length&&req.method!=='GET')return NextResponse.json({error:{code:'document_not_found'}},{status:404});
 const body=req.method==='POST'?await req.text():undefined;if(body&&new TextEncoder().encode(body).length>900000)return NextResponse.json({error:{code:'document_invalid'}},{status:413});
 const query=new URLSearchParams();if(req.nextUrl.searchParams.has('before'))query.set('before',req.nextUrl.searchParams.get('before')!);
 try{const r=await activityGatewayFetch(gatewayUrl(`/api/v1/ai/knowledge/documents/${id}/manage${part.length?'/history':''}?${query}`),{method:req.method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':req.headers.get('idempotency-key')??''},body,signal:AbortSignal.timeout(10000),cache:'no-store'});return NextResponse.json(await r.json(),{status:r.status,headers:{'cache-control':'no-store'}});}catch{return NextResponse.json({error:{code:'document_outcome_unconfirmed'}},{status:503});}
}
export const GET=proxy,POST=proxy;
