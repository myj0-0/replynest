import {NextRequest,NextResponse} from 'next/server';
import {activityGatewayFetch} from '../../../../../lib/activity-gateway-fetch';
import {gatewayUrl,sessionToken} from '../../../../../lib/console-session';
export const dynamic='force-dynamic';
export async function GET(_request:NextRequest,context:{params:Promise<{id:string}>}){
 const {id}=await context.params;if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))return new NextResponse(null,{status:404});
 const token=await sessionToken();if(!token)return new NextResponse(null,{status:401});
 try{
  const r=await activityGatewayFetch(gatewayUrl(`/api/v1/quick-reply-images/${id}/content`),{headers:{authorization:`Bearer ${token}`},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!r.ok)return new NextResponse(null,{status:r.status});
  const mime=r.headers.get('content-type')??'';if(!['image/jpeg','image/png','image/gif'].includes(mime))return new NextResponse(null,{status:502});
  return new NextResponse(r.body,{headers:{'content-type':mime,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'referrer-policy':'no-referrer'}});
 }catch{return new NextResponse(null,{status:503});}
}
