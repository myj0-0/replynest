import type { Pool } from "pg";
import { wechatRejectionState } from "./wechat-send-error.js";
import { sendSharedWechatManualReply, type SharedTransport } from "./shared-wechat-delivery.js";

export class SharedWorkbenchError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export type SharedWorkbenchAuth = { tenantId:string; actorId:string; userId:string; accountId:string };

/** Validate before creating an outgoing workbench message. Never accepts a caller OpenID. */
export async function prepareSharedWorkbenchReply(db:Pool,auth:SharedWorkbenchAuth,
  conversation:{id:unknown;account_id:unknown;inbox_id:unknown;custom_attributes?:unknown},content:string,
  gates:{enabled:boolean;manualSendEnabled:boolean}) {
  const attributes=conversation.custom_attributes as Record<string,unknown>|undefined;
  const marked=attributes?.source_channel==="shared_wechat" || typeof attributes?.replynest_shared_contact==="string";
  if(!gates.enabled) {
    if(marked)throw new SharedWorkbenchError("shared_send_disabled");
    return undefined;
  }
  const found=await db.query(`SELECT b.app_id,b.inbox_id::text,t.name FROM shared_wechat_threads b
    JOIN tenants t ON t.tenant_id=b.tenant_id AND t.chatwoot_account_id=b.account_id AND t.status IN ('active','test')
    WHERE b.tenant_id=$1 AND b.account_id=$2 AND b.conversation_id=$3`,[auth.tenantId,auth.accountId,String(conversation.id)]);
  const binding=found.rows[0];
  if(!binding && !marked)return undefined;
  if(!gates.manualSendEnabled)throw new SharedWorkbenchError("shared_send_disabled");
  if(!binding || String(conversation.account_id)!==auth.accountId || String(conversation.inbox_id)!==binding.inbox_id)throw new SharedWorkbenchError("shared_conversation_not_ready");
  const allowed=await db.query(`SELECT 1 FROM shared_wechat_threads b
    JOIN shared_wechat_enrollments e ON e.app_id=b.app_id AND e.tenant_id=b.tenant_id AND e.enabled=TRUE
    JOIN shared_wechat_accounts a ON a.app_id=b.app_id AND a.enabled=TRUE
    JOIN shared_wechat_inboxes i ON i.app_id=b.app_id AND i.tenant_id=b.tenant_id AND i.account_id=b.account_id AND i.inbox_id=b.inbox_id AND i.enabled=TRUE
    JOIN shared_wechat_routing_states s ON s.app_id=b.app_id AND s.open_id=b.open_id
    JOIN tenant_memberships m ON m.tenant_id=b.tenant_id AND m.platform_user_id=$4 AND m.chatwoot_account_id=b.account_id AND m.status='active'
    WHERE b.app_id=$1 AND b.tenant_id=$2 AND b.conversation_id=$3
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.state->'associations') x WHERE x->>'tenantId'=b.tenant_id)`,[binding.app_id,auth.tenantId,String(conversation.id),auth.userId]);
  if(!allowed.rows[0])throw new SharedWorkbenchError("shared_conversation_not_ready");
  const withMerchant=`【${String(binding.name).replace(/[\r\n]/g," ").slice(0,80)}】\n${content}`;
  if(Buffer.byteLength(withMerchant,"utf8")>1800)throw new SharedWorkbenchError("shared_reply_too_long");
  return {appId:String(binding.app_id),conversationId:String(conversation.id)};
}

/** Manual endpoint only. The normal workbench command/idempotency record must exist first. */
export async function dispatchSharedWorkbenchReply(db:Pool,auth:SharedWorkbenchAuth,
  target:{appId:string;conversationId:string},commandId:string,content:string,transport:SharedTransport) {
  return sendSharedWechatManualReply(db,{...target,tenantId:auth.tenantId,accountId:auth.accountId,commandId,actorId:auth.actorId,content,private:false},async()=>{
    const authorized=await db.query(`SELECT 1 FROM tenant_memberships m
      JOIN conversation_message_commands c ON c.tenant_id=m.tenant_id AND c.platform_user_id=m.platform_user_id
      WHERE m.tenant_id=$1 AND m.platform_user_id=$2 AND m.chatwoot_account_id=$3 AND m.status='active' AND c.command_id=$4`,[auth.tenantId,auth.userId,auth.accountId,commandId]);
    return !!authorized.rows[0];
  },transport);
}

/** Do not trust Chatwoot's 'sent' status for the separate shared-account transport. */
export async function sharedWorkbenchMessageStatus(db:Pool,tenantId:string,commandId:string):Promise<string> {
  const result=await db.query(`SELECT status,provider_error_code FROM shared_wechat_deliveries WHERE tenant_id=$1 AND direction='out' AND command_id=$2`,[tenantId,commandId]);
  if(result.rows[0]?.status==="rejected")return wechatRejectionState(result.rows[0].provider_error_code);
  if(result.rows[0]?.status==="delivered")return "shared_provider_accepted";
  if(result.rows[0]?.status==="uncertain")return "shared_uncertain";
  const command=await db.query(`SELECT response_body FROM conversation_message_commands WHERE tenant_id=$1 AND command_id=$2`,[tenantId,commandId]);
  const state=command.rows[0]?.response_body?.data?.delivery_state;
  if(command.rows[0]?.response_body?.error?.code==="send_outcome_uncertain")return "shared_uncertain";
  return state==="shared_blocked"?state:"shared_pending";
}
