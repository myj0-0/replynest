import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextRequest,NextResponse } from "next/server";
import { consoleUrl,gatewayUrl,hasValidOrigin } from "../../../../lib/console-session";
export async function POST(request:NextRequest){if(!hasValidOrigin(request))return NextResponse.json({error:"invalid_origin"},{status:403});const form=await request.formData();const upstream=await activityGatewayFetch(gatewayUrl("/api/v1/auth/forgot-password"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:String(form.get("email")??""),captcha_token:form.get("cap-token")}),cache:"no-store"});return NextResponse.redirect(consoleUrl(upstream.status===403?"/forgot-password?error=captcha_required":"/forgot-password?sent=1"),303);}
