import {NextRequest} from 'next/server';
import {platformAdminMutation} from '../../../../../../lib/platform-admin-mutation';
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}){const{id}=await params;return platformAdminMutation(request,`privacy-requests/${encodeURIComponent(id)}/notes`,'POST',`/internal-admin/privacy/${encodeURIComponent(id)}`);}
