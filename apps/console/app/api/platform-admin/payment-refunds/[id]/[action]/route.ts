import { NextRequest,NextResponse } from 'next/server';
import { platformAdminMutation } from '../../../../../../lib/platform-admin-mutation';
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string;action:string}>}){
  const {id,action}=await params;if(!/^[0-9a-f-]{36}$/i.test(id)||!['approve','reject'].includes(action))return NextResponse.json({error:'not_found'},{status:404});
  return platformAdminMutation(request,`payment-refunds/${id}/${action}`,'POST','/internal-admin/payment-refunds');
}
