import { NextRequest,NextResponse } from "next/server";
export function proxy(request:NextRequest){
 if(request.nextUrl.pathname==='/demo'||request.nextUrl.pathname.startsWith('/demo/')){
  if(!['GET','HEAD'].includes(request.method))return new NextResponse('Read-only demo',{status:405,headers:{Allow:'GET, HEAD','Cache-Control':'no-store'}});
  const response=NextResponse.next();
  response.headers.set('X-Robots-Tag','noindex, nofollow, noarchive');
  response.headers.set('Cache-Control','no-store');
  response.headers.set('Referrer-Policy','no-referrer');
  response.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  return response;
 }
 const protectedPath=request.nextUrl.pathname.startsWith("/internal-admin")||request.nextUrl.pathname.startsWith("/api/platform-admin");if(!protectedPath)return NextResponse.next();const configured=process.env.PLATFORM_ADMIN_PUBLIC_ORIGIN;if(!configured)return new NextResponse("Not found",{status:404});const expectedHost=new URL(configured).host.toLowerCase();const requestHost=(request.headers.get("x-forwarded-host")??request.headers.get("host")??"").toLowerCase();if(requestHost!==expectedHost)return new NextResponse("Not found",{status:404});const response=NextResponse.next();response.headers.set("X-Robots-Tag","noindex, nofollow, noarchive");response.headers.set("Cache-Control","no-store");return response
}
export const config={matcher:["/internal-admin/:path*","/api/platform-admin/:path*","/demo/:path*"]};
