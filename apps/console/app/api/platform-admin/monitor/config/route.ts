import { NextRequest } from "next/server";
import { platformAdminMutation } from "../../../../../lib/platform-admin-mutation";
export async function POST(request:NextRequest){return platformAdminMutation(request,"monitor/config","PATCH","/internal-admin/monitoring")}
