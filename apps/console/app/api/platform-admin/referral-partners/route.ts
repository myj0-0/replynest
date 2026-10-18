import {NextRequest,NextResponse} from 'next/server';
import {adminToken,adminUrl,fetchPlatformAdminSession,validAdminOrigin} from '../../../../lib/platform-admin-session';
export async function POST(request:NextRequest){
 if(!validAdminOrigin(request))return NextResponse.json({error:'invalid_origin'},{status:403});
 const [session,token]=await Promise.all([fetchPlatformAdminSession(),adminToken()]);
 if(!session||!token)return NextResponse.json({error:'unauthorized'},{status:401});
 if(!['owner','admin'].includes(session.user.role))return NextResponse.json({error:'forbidden'},{status:403});
 const form=await request.formData(),tenant=String(form.get('tenant_id')??'');
 if(!tenant||tenant.length>200||form.getAll('tenant_id').length!==1||form.getAll('expected_version').length!==1||form.getAll('enabled').length>1||!/^\d{1,9}$/.test(String(form.get('expected_version'))))return NextResponse.json({error:'invalid_partner_change'},{status:400});
 const result=(key:string,value:string)=>NextResponse.redirect(adminUrl('/internal-admin/growth-policy?'+new URLSearchParams({tenant_id:tenant,[key]:value})+'#referral-partners'),303);
 try{
  const upstream=await fetch(`${process.env.GATEWAY_INTERNAL_URL}/api/v1/platform-admin/referral-partners`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({tenant_id:tenant,expected_version:Number(form.get('expected_version')),enabled:form.get('enabled')==='true',reason:form.get('reason')}),cache:'no-store',signal:AbortSignal.timeout(7000)});
  if(!upstream.ok){const body=await upstream.json().catch(()=>null);const code=body?.error?.code;return result('partner_error',['partner_version_conflict','active_tenant_required','invalid_partner_change','referral_partner_disabled'].includes(code)?code:'operation_failed');}
  return result('partner_saved','1');
 }catch{return result('partner_error','unavailable');}
}
