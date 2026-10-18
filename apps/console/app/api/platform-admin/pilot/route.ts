import { NextRequest,NextResponse } from "next/server";
import { adminToken,validAdminOrigin } from "../../../../lib/platform-admin-session";

const UUID=/^[0-9a-f-]{36}$/i;
export async function POST(request:NextRequest){
  if(!validAdminOrigin(request))return NextResponse.json({error:{code:"invalid_origin"}},{status:403});
  const token=await adminToken();if(!token)return NextResponse.json({error:{code:"session_expired"}},{status:401});
  let body:Record<string,unknown>;try{body=await request.json()}catch{return NextResponse.json({error:{code:"invalid_request"}},{status:400})}
  const operation=String(body.operation??""),batchId=String(body.pilot_batch_id??""),inviteId=String(body.pilot_invite_id??"");let path="",payload:Record<string,unknown>={};
  if(operation==="create_batch"){path="pilot/batches";payload=body}
  else if(UUID.test(batchId)&&operation==="set_check"){path=`pilot/batches/${batchId}/checks`;payload=body}
  else if(UUID.test(batchId)&&operation==="rollback_rehearsal"){path=`pilot/batches/${batchId}/rollback-rehearsal`}
  else if(UUID.test(batchId)&&operation==="transition"){path=`pilot/batches/${batchId}/transition`;payload=body}
  else if(UUID.test(batchId)&&operation==="issue_invite"){path=`pilot/batches/${batchId}/invites`;payload=body}
  else if(UUID.test(inviteId)&&operation==="revoke_invite"){path=`pilot/invites/${inviteId}/revoke`;payload=body}
  else return NextResponse.json({error:{code:"invalid_pilot_operation"}},{status:400});
  try{const upstream=await fetch(`${process.env.GATEWAY_INTERNAL_URL}/api/v1/platform-admin/${path}`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(payload),cache:"no-store",signal:AbortSignal.timeout(7000)});const result=await upstream.json();return NextResponse.json(result,{status:upstream.status})}catch{return NextResponse.json({error:{code:"upstream_unavailable"}},{status:503})}
}
