import { NextRequest,NextResponse } from "next/server";
import { adminToken,adminUrl,validAdminOrigin } from "../../../../../../lib/platform-admin-session";
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}){
  if(!validAdminOrigin(request))return NextResponse.json({error:"invalid_origin"},{status:403});
  const token=await adminToken();if(!token)return NextResponse.redirect(adminUrl("/internal-admin/login?error=invalid"),303);
  const{id}=await params,form=await request.formData(),action=String(form.get("_action")??"");
  const method=action==="delete"?"DELETE":action==="test"?"POST":"PATCH",suffix=action==="test"?"/test":"";
  const body=method==="PATCH"?JSON.stringify({display_name:String(form.get("display_name")??""),status:String(form.get("status")??"")}):undefined;
  try{const upstream=await fetch(`${process.env.GATEWAY_INTERNAL_URL}/api/v1/platform-admin/monitor/destinations/${encodeURIComponent(id)}${suffix}`,{method,headers:{authorization:`Bearer ${token}`,...(body?{"content-type":"application/json"}:{})},body,cache:"no-store",signal:AbortSignal.timeout(action==="test"?130000:12000)});return NextResponse.redirect(adminUrl(`/internal-admin/monitoring?${upstream.ok?"saved=1":"error=operation_failed"}`),303)}catch{return NextResponse.redirect(adminUrl("/internal-admin/monitoring?error=unavailable"),303)}
}
