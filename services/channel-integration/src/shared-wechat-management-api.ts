import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { readBody, sendJson } from "./shared.js";
import { manageSharedWechat, sharedWechatOverview, type SharedManagementOptions } from "./shared-wechat-management.js";

export async function handleSharedWechatManagement(req:IncomingMessage,res:ServerResponse,url:URL,
  auth:{tenant_id:string;actor_id:string;role:string},requestId:string,
  deps:{db:Pool;enabled:boolean;options:SharedManagementOptions}):Promise<boolean> {
  if(url.pathname!=="/api/v1/channels/shared-wechat") return false;
  res.setHeader("cache-control","private, no-store");
  const respond=(status:number,body:Record<string,unknown>)=>{sendJson(res,status,{request_id:requestId,...body});return true;};
  if(auth.role!=="tenant_admin") return respond(403,{error:{code:"admin_required"}});
  if(!deps.enabled) return req.method==="GET" ? respond(200,{data:{available:false,requested:false,enabled:false,entry_ready:false,scenes:[]}}) : respond(409,{error:{code:"shared_management_disabled"}});
  try {
    if(req.method==="GET")return respond(200,{data:await sharedWechatOverview(deps.db,auth.tenant_id,deps.options)});
    if(req.method!=="POST")return respond(405,{error:{code:"method_not_allowed"}});
    let input:Record<string,unknown>;
    try {const body=await readBody(req);if(body.length>2048)throw new Error(); input=JSON.parse(body.toString("utf8"));if(!input || typeof input!=="object" || Array.isArray(input))throw new Error();}
    catch {return respond(400,{error:{code:"invalid_input"}});}
    return respond(200,{data:await manageSharedWechat(deps.db,{tenantId:auth.tenant_id,actorId:auth.actor_id,role:auth.role},input,deps.options)});
  } catch(error) {
    const known:Record<string,number>={admin_required:403,invalid_input:400,tenant_unavailable:403,qr_not_found:404,entry_not_ready:409,qr_limit_reached:429,qr_rate_limited:429};
    const code=error instanceof Error && known[error.message]?error.message:"shared_operation_unconfirmed";
    return respond(known[code]??503,{error:{code}});
  }
}
