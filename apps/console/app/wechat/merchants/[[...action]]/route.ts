import { NextRequest,NextResponse } from "next/server";
import { gatewayUrl } from "../../../../lib/console-session";
async function proxy(request:NextRequest,{params}:{params:Promise<{action?:string[]}>}) {
  if((request.headers.get("x-forwarded-host")??request.headers.get("host"))!=="replynest.cn")return NextResponse.redirect(new URL(request.nextUrl.pathname+request.nextUrl.search,"https://replynest.cn"));
  const action=(await params).action??[];
  if(action.length>1 || (action.length && !["start","callback","select"].includes(action[0])))return new NextResponse("Not found",{status:404});
  if(request.method==="POST" && request.headers.get("origin")!=="https://replynest.cn")return new NextResponse("Forbidden",{status:403});
  const body=request.method==="POST"?await request.text():undefined;
  if(body&&body.length>4096)return new NextResponse("Too large",{status:413});
  const target=gatewayUrl(`/public/shared-wechat-portal${action.length?`/${action[0]}`:"/"}${request.nextUrl.search}`);
  try {
    const upstream=await fetch(target,{method:request.method,body,redirect:"manual",cache:"no-store",signal:AbortSignal.timeout(15000),headers:{cookie:request.headers.get("cookie")??"",origin:request.headers.get("origin")??"","user-agent":request.headers.get('user-agent')??'',"content-type":"application/x-www-form-urlencoded"}});
    const headers=new Headers();for(const name of ["content-type","location","cache-control","referrer-policy","content-security-policy","x-content-type-options","x-robots-tag"]) {const v=upstream.headers.get(name);if(v)headers.set(name,v);}
    for(const c of upstream.headers.getSetCookie())headers.append("set-cookie",c);
    return new NextResponse(await upstream.text(),{status:upstream.status,headers});
  }catch{return new NextResponse("暂时无法连接，请稍后重试。",{status:503,headers:{"cache-control":"no-store"}});}
}
export const GET=proxy;export const POST=proxy;
