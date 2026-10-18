import {NextRequest,NextResponse} from 'next/server';
import {adminToken,validAdminOrigin} from '../../../../../lib/platform-admin-session';
async function forward(req:NextRequest,context:{params:Promise<{path?:string[]}>}){
 const {path=[]}=await context.params;
 if(path.length>1||path.some(p=>!/^[a-zA-Z0-9-]+$/.test(p)))return NextResponse.json({error:{code:'not_found'}},{status:404});
 if(req.method==='POST'&&!validAdminOrigin(req))return NextResponse.json({error:{code:'forbidden'}},{status:403});
 const token=await adminToken();if(!token)return NextResponse.json({error:{code:'unauthorized'}},{status:401});
 try{const body=req.method==='POST'?await req.text():undefined;if(body&&body.length>4096)return NextResponse.json({error:{code:'too_large'}},{status:413});
 const r=await fetch(`${process.env.GATEWAY_INTERNAL_URL}/api/v1/platform-admin/template-market${path.length?'/'+path.join('/'):''}${req.nextUrl.search}`,{method:req.method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body,cache:'no-store',signal:AbortSignal.timeout(15000)});
 return NextResponse.json(await r.json(),{status:r.status,headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:{code:'market_unavailable'}},{status:503});}
}
export const GET=forward;export const POST=forward;
