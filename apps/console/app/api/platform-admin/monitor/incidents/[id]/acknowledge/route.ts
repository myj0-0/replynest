import { NextRequest } from "next/server";
import { platformAdminMutation } from "../../../../../../../lib/platform-admin-mutation";
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}){const{id}=await params;return platformAdminMutation(request,`monitor/incidents/${encodeURIComponent(id)}/acknowledge`,"POST","/internal-admin/monitoring")}
