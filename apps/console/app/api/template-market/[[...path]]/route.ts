import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import {NextRequest,NextResponse} from 'next/server';
import {gatewayUrl,hasValidOrigin,sessionToken} from '../../../../lib/console-session';
async function forward(req:NextRequest,context:{params:Promise<{path?:string[]}>}){
 const {path=[]}=await context.params;
 if(path.length>2||path.some(p=>!/^[a-zA-Z0-9-]+$/.test(p)))return NextResponse.json({error:{code:'not_found'}},{status:404});
 if(req.method==='POST'&&!hasValidOrigin(req))return NextResponse.json({error:{code:'forbidden'}},{status:403});
 const token=await sessionToken();if(!token)return NextResponse.json({error:{code:'unauthorized'}},{status:401});
 try{const body=req.method==='POST'?await req.text():undefined;if(body&&new TextEncoder().encode(body).length>300000)return NextResponse.json({error:{code:'too_large'}},{status:413});
 const r=await activityGatewayFetch(gatewayUrl('/api/v1/template-market'+(path.length?'/'+path.join('/'):'')+req.nextUrl.search),{method:req.method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body,cache:'no-store',signal:AbortSignal.timeout(15000)});
 return NextResponse.json(await r.json(),{status:r.status,headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:{code:'market_unavailable'}},{status:503});}
}
export const GET=forward;export const POST=forward;
