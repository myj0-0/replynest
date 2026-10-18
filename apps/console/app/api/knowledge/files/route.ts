import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, sessionToken } from "../../../../lib/console-session";

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token=await sessionToken(); if(!token) return NextResponse.redirect(consoleUrl("/login?error=expired"),303);
  const input=await request.formData(); const file=input.get("file");
  if(!(file instanceof File)) return NextResponse.redirect(consoleUrl("/knowledge?result=failed"),303);
  const upstreamForm=new FormData(); upstreamForm.set("title",String(input.get("title")??"")); upstreamForm.set("source_type",String(input.get("source_type")??"knowledge")); upstreamForm.set("file",file,file.name);
  if(input.has('document_settings'))upstreamForm.set('document_settings',String(input.get('document_settings')));
  const upstream=await activityGatewayFetch(gatewayUrl("/api/v1/ai/knowledge/files"),{method:"POST",headers:{authorization:`Bearer ${token}`,"idempotency-key":randomUUID()},body:upstreamForm,cache:"no-store"});
  return NextResponse.redirect(consoleUrl(`/knowledge?result=${upstream.ok?"uploaded":"failed"}`),303);
}
