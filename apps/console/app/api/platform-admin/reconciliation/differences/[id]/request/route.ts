import { NextRequest } from "next/server";
import { platformAdminMutation } from "../../../../../../../lib/platform-admin-mutation";
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}){const{id}=await params;return platformAdminMutation(request,`reconciliation/differences/${encodeURIComponent(id)}/repair-requests`,"POST","/internal-admin/reconciliation")}
