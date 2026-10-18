import { NextRequest } from "next/server";
import { platformAdminMutation } from "../../../../../lib/platform-admin-mutation";
export async function POST(request:NextRequest){return platformAdminMutation(request,"mfa/enroll")}
