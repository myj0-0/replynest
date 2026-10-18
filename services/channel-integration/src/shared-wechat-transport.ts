import type { SharedTransport } from "./shared-wechat-delivery.js";
import { sendOfficialText,sendSharedOfficialText, type WeChatConfig } from "./wechat-official.js";

type RecordValue = Record<string, any>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shared_upstream_shape");
  return value as RecordValue;
}
function id(value: unknown): string {
  const text=String(value ?? "");
  if(!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error("shared_upstream_id");
  return text;
}

/** Explicit factory, never reads a global default account/inbox. The inbound worker
 * and manual workbench sender each supply independent, default-off gates.
 */
export function createSharedWechatTransport(options: {
  chatwootBaseUrl: string; chatwootToken: string; fetcher?: typeof fetch;
  resolveWeChat: (appId: string) => Promise<WeChatConfig>;
  liveSendEnabled: boolean;
  sender?: typeof sendOfficialText;
}): SharedTransport {
  const base=new URL(options.chatwootBaseUrl);
  if(!["https:","http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname!=="/" || !options.chatwootToken) throw new Error("shared_transport_config");
  const fetcher=options.fetcher ?? fetch;
  async function call(path:string,body?:RecordValue):Promise<RecordValue> {
    // Do not include upstream bodies, token-bearing URLs, or credentials in errors.
    const response=await fetcher(`${base.origin}${path}`,{method:body?"POST":"GET",redirect:"error",signal:AbortSignal.timeout(10000),
      headers:{api_access_token:options.chatwootToken,"content-type":"application/json","x-forwarded-proto":"https"},...(body?{body:JSON.stringify(body)}:{})});
    if(!response.ok) throw new Error(`shared_upstream_http_${response.status}`);
    return record(await response.json());
  }
  return {
    receive:async(target,message,existing)=>{
      const account=id(target.accountId),inbox=id(target.inboxId),prefix=`/api/v1/accounts/${account}`;
      if(existing && (existing.accountId!==account || existing.inboxId!==inbox)) throw new Error("shared_binding_mismatch");
      const upstreamInbox=await call(`${prefix}/inboxes/${inbox}`);
      if(id(upstreamInbox.id)!==inbox || upstreamInbox.channel_type!=="Channel::Api" || (upstreamInbox.account_id!==undefined && id(upstreamInbox.account_id)!==account)) throw new Error("shared_inbox_mismatch");
      let conversation: string;
      if(existing) conversation=id(existing.conversationId);
      else {
        const created=await call(`${prefix}/contacts`,{inbox_id:Number(inbox),identifier:message.contactKey,name:"微信访客",custom_attributes:{source_channel:"shared_wechat"}});
        // Chatwoot releases return either payload.contact or the documented payload array.
        const contact=record(Array.isArray(created.payload)?created.payload[0]:record(created.payload).contact);
        if(contact.identifier!==message.contactKey) throw new Error("shared_contact_mismatch");
        const link=Array.isArray(contact.contact_inboxes)?contact.contact_inboxes.find((item:RecordValue)=>String(item.inbox?.id)===inbox):undefined;
        if(!link || typeof link.source_id!=="string" || !link.source_id) throw new Error("shared_contact_inbox_missing");
        const createdConversation=await call(`${prefix}/conversations`,{inbox_id:Number(inbox),contact_id:Number(id(contact.id)),source_id:link.source_id,
          custom_attributes:{source_channel:"shared_wechat",replynest_shared_contact:message.contactKey}});
        conversation=id(createdConversation.id);
      }
      // Verify through the account-scoped read before writing the actual message.
      const verified=await call(`${prefix}/conversations/${conversation}`);
      if(id(verified.id)!==conversation || id(verified.account_id)!==account || id(verified.inbox_id)!==inbox || verified.custom_attributes?.replynest_shared_contact!==message.contactKey) throw new Error("shared_conversation_mismatch");
      const contactId=id(verified.meta?.sender?.id);
      const posted=await call(`${prefix}/conversations/${conversation}/messages`,{content:message.content,message_type:"incoming",private:false,content_type:"text",content_attributes:{replynest_shared_event_id:message.eventId}});
      if(id(posted.conversation_id)!==conversation || (posted.account_id!==undefined && id(posted.account_id)!==account)) throw new Error("shared_message_mismatch");
      return {accountId:account,inboxId:inbox,conversationId:conversation,contactId,messageId:id(posted.id)};
    },
    send:async(target,message)=>{
      if(!options.liveSendEnabled) throw new Error("shared_send_disabled");
      const config=await options.resolveWeChat(target.appId);
      if(config.appId!==target.appId) throw new Error("shared_sender_account_mismatch");
      await (options.sender ?? sendSharedOfficialText)(target.openId,message.content,config);
    }
  };
}
