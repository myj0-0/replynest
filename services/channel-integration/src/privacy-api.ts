import type { IncomingMessage,ServerResponse } from "node:http";
import { createPrivacyRequest,listMyPrivacyRequests } from "./privacy-lifecycle.js";
import { readBody,sendJson } from "./shared.js";

type Auth={tenant_id:string;platform_user_id:string|null;auth_kind:string;role:string};
function reply(response:ServerResponse,status:number,requestId:string,body:Record<string,unknown>){sendJson(response,status,{request_id:requestId,...body})}
export async function handlePrivacyApi(request:IncomingMessage,response:ServerResponse,url:URL,auth:Auth,requestId:string){
  if(!url.pathname.startsWith("/api/v1/privacy/requests"))return false;
  if(auth.auth_kind!=="console_session"||!auth.platform_user_id){reply(response,403,requestId,{error:{code:"console_identity_required"}});return true}
  if(request.method==="GET"&&url.pathname==="/api/v1/privacy/requests"){
    try{const result=await listMyPrivacyRequests(auth.tenant_id,auth.platform_user_id,undefined,url.searchParams);reply(response,200,requestId,{data:result.items,pagination:result.pagination})}
    catch(error){const invalid=error instanceof Error&&error.message==='invalid_privacy_cursor';reply(response,invalid?400:503,requestId,{error:{code:invalid?'invalid_privacy_cursor':'privacy_history_unavailable'}})}return true
  }
  if(request.method==="POST"&&url.pathname==="/api/v1/privacy/requests"){
    try{const input=JSON.parse((await readBody(request)).toString("utf8"))as Record<string,unknown>;const result=await createPrivacyRequest({tenant_id:auth.tenant_id,platform_user_id:auth.platform_user_id,request_type:String(input.request_type??""),details:input.details,request_id:requestId});reply(response,result.idempotent_replay?200:201,requestId,{data:result})}
    catch(error){reply(response,400,requestId,{error:{code:error instanceof Error?error.message:"privacy_request_failed"}})}return true
  }
  reply(response,404,requestId,{error:{code:"not_found"}});return true;
}
