import {activityGatewayFetch} from "../../../../../../../lib/activity-gateway-fetch";
import {NextRequest,NextResponse} from 'next/server';
import {consoleUrl,gatewayUrl,hasValidOrigin,sessionToken} from '../../../../../../../lib/console-session';
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string;batchId:string}>}){
 if(!hasValidOrigin(request))return NextResponse.json({error:'invalid_origin'},{status:403});
 const token=await sessionToken();
 if(!token)return NextResponse.redirect(consoleUrl('/login?error=expired'),303);
 const {id,batchId}=await params;
 if(!/^[0-9a-f-]{36}$/i.test(id)||!/^[0-9a-f-]{36}$/i.test(batchId))return NextResponse.json({error:'invalid_id'},{status:400});
 const form=await request.formData();const reason=String(form.get('reason')??'').trim();
 let result='review-invalid';
 if(reason.length>=10&&reason.length<=500){
  try{
   const response=await activityGatewayFetch(gatewayUrl(`/api/v1/message-campaigns/${id}/mass-batches/${batchId}/review`),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({reason}),cache:'no-store',signal:AbortSignal.timeout(10000)});
   result=response.ok?'mass-reviewed':response.status===403?'review-forbidden':'review-failed';
  }catch{result='review-failed';}
 }
 return NextResponse.redirect(consoleUrl(`/operations/outbound/${id}?result=${result}`),303);
}
