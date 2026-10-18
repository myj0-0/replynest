import {activityGatewayFetch} from "../../../../../../lib/activity-gateway-fetch";
import { NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, sessionToken } from "../../../../../../lib/console-session";

export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
  const token=await sessionToken();if(!token)return NextResponse.redirect(consoleUrl("/login?error=expired"),303);
  const {id}=await params;if(!/^[0-9a-f-]{36}$/i.test(id))return NextResponse.json({error:"invalid_document_id"},{status:400});
  const upstream=await activityGatewayFetch(gatewayUrl(`/api/v1/ai/knowledge/documents/${id}/download`),{headers:{authorization:`Bearer ${token}`},cache:"no-store"});
  if(upstream.status===401)return NextResponse.redirect(consoleUrl("/login?error=expired"),303);
  const headers=new Headers({"cache-control":"private, no-store","x-content-type-options":"nosniff"});
  for(const name of ["content-type","content-length","content-disposition","x-request-id"]){const value=upstream.headers.get(name);if(value)headers.set(name,value);}
  return new NextResponse(upstream.body,{status:upstream.status,headers});
}
