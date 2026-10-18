import {NextRequest,NextResponse} from 'next/server';
import {adminToken,adminUrl,fetchPlatformAdminSession,validAdminOrigin} from '../../../../lib/platform-admin-session';
export async function POST(request:NextRequest){
 if(!validAdminOrigin(request))return NextResponse.json({error:'invalid_origin'},{status:403});
 const [session,token]=await Promise.all([fetchPlatformAdminSession(),adminToken()]);
 if(!session||!token)return NextResponse.json({error:'unauthorized'},{status:401});
 if(!['owner','admin'].includes(session.user.role))return NextResponse.json({error:'forbidden'},{status:403});
 const form=await request.formData(),money=form.get('cash_yuan'),version=form.get('expected_version'),reason=form.get('reason');
 if(['cash_yuan','expected_version','reason'].some(k=>form.getAll(k).length!==1)||typeof money!=='string'||!/^\d{1,7}(\.\d{1,2})?$/.test(money)||typeof version!=='string'||!/^\d{1,9}$/.test(version)||typeof reason!=='string'||reason.trim().length<10||reason.trim().length>500)return NextResponse.json({error:'invalid_referral_threshold'},{status:400});
 const [whole,fraction='']=money.split('.'),cash=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 if(cash>100000000||Number(version)<1)return NextResponse.json({error:'invalid_referral_threshold'},{status:400});
 const result=(key:string,value:string)=>NextResponse.redirect(adminUrl('/internal-admin/growth-policy?'+new URLSearchParams({[key]:value})+'#referral-qualification'),303);
 try{
  const upstream=await fetch(`${process.env.GATEWAY_INTERNAL_URL}/api/v1/platform-admin/referral-threshold`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({cash_minor:cash,expected_version:Number(version),reason:reason.trim()}),cache:'no-store',signal:AbortSignal.timeout(7000)});
  if(!upstream.ok){const body=await upstream.json().catch(()=>null),code=body?.error?.code;return result('threshold_error',['version_conflict','invalid_referral_threshold','referral_campaign_unavailable'].includes(code)?code:'operation_failed');}
  return result('threshold_saved','1');
 }catch{return result('threshold_error','unavailable');}
}
