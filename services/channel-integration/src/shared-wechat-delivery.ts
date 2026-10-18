import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {recordReceptionEvent} from './reception-store.js';
import { WeChatSendRejected, wechatRejectionState } from "./wechat-send-error.js";
import {queueWechatMedia} from './wechat-media-store.js';
import type {WeChatMedia} from './wechat-media-core.js';
import {recordInboundAttention} from './conversation-attention.js';
import type {InsightReceiptHooks} from './customer-insights-sources.js';

export type SharedDestination = { appId: string; tenantId: string; accountId: string; inboxId: string; openId: string };
export type SharedConversation = { accountId: string; inboxId: string; conversationId: string; contactId?:string };
export type SharedTransport = {
  // Implementations must verify the upstream account/inbox before any message write.
  receive: (destination: SharedDestination, message: { content: string; eventId: string; contactKey: string }, existing?: SharedConversation) => Promise<SharedConversation & { messageId: string }>;
  send: (destination: SharedDestination, message: { content: string; commandId: string }) => Promise<void>;
};
export type SharedDeliveryResult = "delivered" | "uncertain" | "blocked" | "duplicate" | "private_note" | ReturnType<typeof wechatRejectionState>;

/** Explicit staging migration. No timer or live transport is installed by this module. */
export function sharedWechatDeliverySchemaSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS shared_wechat_threads (
      app_id TEXT NOT NULL,tenant_id TEXT NOT NULL,open_id TEXT NOT NULL,
      account_id BIGINT NOT NULL,inbox_id BIGINT NOT NULL,conversation_id BIGINT NOT NULL,
      PRIMARY KEY(app_id,tenant_id,open_id),UNIQUE(account_id,conversation_id),
      FOREIGN KEY(app_id,tenant_id) REFERENCES shared_wechat_inboxes(app_id,tenant_id)
    );
    ALTER TABLE shared_wechat_threads ADD COLUMN IF NOT EXISTS contact_id BIGINT CHECK(contact_id>0);
    CREATE TABLE IF NOT EXISTS shared_wechat_deliveries (
      app_id TEXT NOT NULL,direction TEXT NOT NULL CHECK(direction IN ('in','out')),command_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,open_id TEXT NOT NULL,request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('uncertain','delivered')),
      upstream_message_id TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(app_id,direction,command_id),
      FOREIGN KEY(app_id,tenant_id) REFERENCES shared_wechat_enrollments(app_id,tenant_id)
    );
    CREATE INDEX IF NOT EXISTS shared_wechat_delivery_contact_uncertain
      ON shared_wechat_deliveries(app_id,tenant_id,open_id) WHERE direction='in' AND status='uncertain';
    CREATE INDEX IF NOT EXISTS shared_wechat_delivery_reception_scan
      ON shared_wechat_deliveries(tenant_id,created_at,command_id) WHERE direction='in' AND status='delivered';
    ALTER TABLE shared_wechat_deliveries ADD COLUMN IF NOT EXISTS provider_error_code INTEGER;
    ALTER TABLE shared_wechat_deliveries DROP CONSTRAINT IF EXISTS shared_wechat_deliveries_status_check;
    ALTER TABLE shared_wechat_deliveries ADD CONSTRAINT shared_wechat_deliveries_status_check CHECK(status IN ('uncertain','delivered','rejected'));
    CREATE INDEX IF NOT EXISTS shared_wechat_receipts_pending
      ON shared_wechat_receipts(created_at,event_id) WHERE delivery_state='held' AND decision->>'action'='route';
  `;
}
export async function migrateSharedWechatDelivery(db: Pool) {
  await db.query(sharedWechatDeliverySchemaSql());
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const positiveId = (value: string) => /^[1-9]\d*$/.test(value);
function destination(row: Record<string, unknown>, appId: string): SharedDestination {
  return { appId,tenantId:String(row.tenant_id),accountId:String(row.account_id),inboxId:String(row.inbox_id),openId:String(row.open_id) };
}
const enabledJoin = `JOIN shared_wechat_accounts a ON a.app_id=e.app_id AND a.enabled=TRUE
  JOIN tenants t ON t.tenant_id=e.tenant_id AND t.status IN ('active','test')
  JOIN shared_wechat_inboxes i ON i.app_id=e.app_id AND i.tenant_id=e.tenant_id AND i.enabled=TRUE AND i.account_id=t.chatwoot_account_id`;

/** Intentionally commit 'uncertain' BEFORE the external call. A crash/timeout may have
 * delivered already: no automatic retry, including after process restart. Recovery
 * must reconcile upstream evidence; changing the command ID is not a retry policy.
 */
export async function deliverSharedWechatInbound(db: Pool, appId: string, eventId: string, transport: SharedTransport,
 options:{insights?:InsightReceiptHooks['shared']}={}): Promise<SharedDeliveryResult> {
  const client = await db.connect();
  let target: SharedDestination, content: string, existing: SharedConversation | undefined,media:WeChatMedia|undefined;
  try {
    await client.query("BEGIN");
    const receipt = await client.query(`SELECT * FROM shared_wechat_receipts WHERE app_id=$1 AND event_id=$2 FOR UPDATE`,[appId,eventId]);
    const r = receipt.rows[0];
    if (!r || r.decision.action !== "route" || r.delivery_state !== "held" || typeof r.text_content !== "string") { await client.query("ROLLBACK"); return "blocked"; }
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[JSON.stringify(["shared-delivery",appId,r.destination_tenant_id,r.open_id])]);
    const prior = await client.query(`SELECT status FROM shared_wechat_deliveries WHERE app_id=$1 AND direction='in' AND command_id=$2`,[appId,eventId]);
    if (prior.rows[0]) { await client.query("COMMIT"); return prior.rows[0].status === "delivered" ? "duplicate" : "uncertain"; }
    const gate = await client.query(`SELECT e.tenant_id,i.account_id::text,i.inbox_id::text FROM shared_wechat_enrollments e ${enabledJoin}
      WHERE e.app_id=$1 AND e.tenant_id=$2 AND e.enabled=TRUE FOR SHARE OF e,a,t,i`,[appId,r.destination_tenant_id]);
    if (!gate.rows[0]) { await client.query("ROLLBACK"); return "blocked"; }
    target = destination({...gate.rows[0],open_id:r.open_id},appId); content=r.text_content;media=r.media_payload??undefined;
    const thread = await client.query(`SELECT account_id::text,inbox_id::text,conversation_id::text FROM shared_wechat_threads WHERE app_id=$1 AND tenant_id=$2 AND open_id=$3`,[appId,target.tenantId,target.openId]);
    if (thread.rows[0]) {
      const b=thread.rows[0];
      if(b.account_id!==target.accountId || b.inbox_id!==target.inboxId) { await client.query("ROLLBACK"); return "blocked"; }
      existing={accountId:b.account_id,inboxId:b.inbox_id,conversationId:b.conversation_id};
    }
    // Serialise uncertain writes for a contact, including first conversation creation.
    const uncertain=await client.query(`SELECT 1 FROM shared_wechat_deliveries WHERE app_id=$1 AND tenant_id=$2 AND open_id=$3 AND direction='in' AND status='uncertain' LIMIT 1`,[appId,target.tenantId,target.openId]);
    if(uncertain.rowCount) { await client.query("ROLLBACK"); return "blocked"; }
    await client.query(`INSERT INTO shared_wechat_deliveries(app_id,direction,command_id,tenant_id,open_id,request_hash,status) VALUES($1,'in',$2,$3,$4,$5,'uncertain')`,[appId,eventId,target.tenantId,target.openId,digest([target,content])]);
    await client.query("COMMIT");
  } catch(error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  try {
    const result=await transport.receive(target,{content,eventId,contactKey:`rn_shared_${digest([appId,target.tenantId,target.openId])}`},existing);
    if(result.accountId!==target.accountId || result.inboxId!==target.inboxId || !positiveId(result.conversationId) || !positiveId(result.messageId) ||
      (result.contactId!==undefined&&!positiveId(result.contactId)) || (existing && result.conversationId!==existing.conversationId)) return "uncertain";
    let queuedMedia:Awaited<ReturnType<typeof queueWechatMedia>>;
    const finish=await db.connect();
    try {
      await finish.query("BEGIN");
      const thread=await finish.query(`INSERT INTO shared_wechat_threads(app_id,tenant_id,open_id,account_id,inbox_id,conversation_id,contact_id) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(app_id,tenant_id,open_id) DO UPDATE SET contact_id=COALESCE(shared_wechat_threads.contact_id,EXCLUDED.contact_id)
        WHERE shared_wechat_threads.account_id=EXCLUDED.account_id AND shared_wechat_threads.inbox_id=EXCLUDED.inbox_id
          AND shared_wechat_threads.conversation_id=EXCLUDED.conversation_id
          AND (shared_wechat_threads.contact_id IS NULL OR EXCLUDED.contact_id IS NULL OR shared_wechat_threads.contact_id=EXCLUDED.contact_id)
        RETURNING conversation_id`,[appId,target.tenantId,target.openId,target.accountId,target.inboxId,result.conversationId,result.contactId??null]);
      if(thread.rowCount!==1)throw Error('shared_thread_binding_changed');
      await finish.query(`UPDATE shared_wechat_deliveries SET status='delivered',upstream_message_id=$3 WHERE app_id=$1 AND direction='in' AND command_id=$2`,[appId,eventId,result.messageId]);
      if(media)queuedMedia=await queueWechatMedia(finish,{tenantId:target.tenantId,accountId:target.accountId,conversationId:result.conversationId,messageId:result.messageId,appId,media});
      if(!media&&process.env.AI_RECEPTION_DRAFT_WORKER_ENABLED==='true')await recordReceptionEvent(finish,{
        tenantId:target.tenantId,accountId:target.accountId,inboxId:target.inboxId,
        conversationId:result.conversationId,messageId:result.messageId,channel:'shared_wechat'});
      if(!media)await options.insights?.(finish,appId,eventId);
      await finish.query("COMMIT");
    } catch(error) { await finish.query("ROLLBACK"); throw error; } finally { finish.release(); }
    if(queuedMedia)await recordInboundAttention({tenant_id:target.tenantId,conversation_id:result.conversationId,message_id:queuedMedia.messageId,text:content,media:queuedMedia.notice,occurred_at:queuedMedia.occurredAt,notify:false}).catch(()=>{});
    return "delivered";
  } catch { return "uncertain"; }
}

export type SharedManualReply = { appId: string; tenantId: string; accountId: string; conversationId: string; commandId: string; actorId: string; content: string; private: boolean };
/** Called only from an authenticated manual-send action. Authorization is rechecked
 * by the supplied membership/role adapter; no AI/automatic sender is wired here.
 * Recipient is resolved from the tenant-owned conversation, NOT current merchant selection.
 */
export async function sendSharedWechatManualReply(db: Pool, reply: SharedManualReply, authorize: (reply: SharedManualReply) => Promise<boolean>, transport: SharedTransport): Promise<SharedDeliveryResult> {
  if (!await authorize(reply)) return "blocked";
  if (reply.private) return "private_note"; // The workbench persists notes; never call WeChat.
  if (!reply.actorId || !/^[A-Za-z0-9_-]{1,100}$/.test(reply.commandId) || !reply.content.trim() || !positiveId(reply.accountId) || !positiveId(reply.conversationId)) return "blocked";
  const hash=digest(reply);
  const client=await db.connect(); let target: SharedDestination, content: string;
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[JSON.stringify(["shared-reply",reply.appId,reply.commandId])]);
    const prior=await client.query(`SELECT request_hash,status,provider_error_code FROM shared_wechat_deliveries WHERE app_id=$1 AND direction='out' AND command_id=$2`,[reply.appId,reply.commandId]);
    if(prior.rows[0]) {
      await client.query("COMMIT");
      return prior.rows[0].request_hash!==hash ? "blocked" : prior.rows[0].status==="delivered" ? "duplicate" : prior.rows[0].status==="rejected" ? wechatRejectionState(prior.rows[0].provider_error_code) : "uncertain";
    }
    const found=await client.query(`SELECT e.tenant_id,i.account_id::text,i.inbox_id::text,b.open_id,t.name
      FROM shared_wechat_enrollments e ${enabledJoin}
      JOIN shared_wechat_threads b ON b.app_id=e.app_id AND b.tenant_id=e.tenant_id AND b.account_id=i.account_id AND b.inbox_id=i.inbox_id
      JOIN shared_wechat_routing_states s ON s.app_id=b.app_id AND s.open_id=b.open_id
      WHERE e.app_id=$1 AND e.tenant_id=$2 AND e.enabled=TRUE AND b.account_id=$3 AND b.conversation_id=$4
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.state->'associations') x WHERE x->>'tenantId'=e.tenant_id)
      FOR SHARE OF e,a,t,i,b,s`,[reply.appId,reply.tenantId,reply.accountId,reply.conversationId]);
    if(!found.rows[0]) { await client.query("ROLLBACK"); return "blocked"; }
    target=destination(found.rows[0],reply.appId);
    content=`【${String(found.rows[0].name).replace(/[\r\n]/g," ").slice(0,80)}】\n${reply.content}`;
    // Never silently truncate a customer's reply. Conservative text-only staging limit.
    if(Buffer.byteLength(content,"utf8")>1800) { await client.query("ROLLBACK"); return "blocked"; }
    await client.query(`INSERT INTO shared_wechat_deliveries(app_id,direction,command_id,tenant_id,open_id,request_hash,status) VALUES($1,'out',$2,$3,$4,$5,'uncertain')`,[reply.appId,reply.commandId,reply.tenantId,target.openId,hash]);
    await client.query("COMMIT");
  } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  try {
    await transport.send(target,{content,commandId:reply.commandId});
    await db.query(`UPDATE shared_wechat_deliveries SET status='delivered' WHERE app_id=$1 AND direction='out' AND command_id=$2`,[reply.appId,reply.commandId]);
    return "delivered";
  } catch(error) {
    if(error instanceof WeChatSendRejected) {
      try {
        await db.query(`UPDATE shared_wechat_deliveries SET status='rejected',provider_error_code=$3 WHERE app_id=$1 AND direction='out' AND command_id=$2`,[reply.appId,reply.commandId,error.providerCode]);
        return wechatRejectionState(error.providerCode);
      } catch { return "uncertain"; }
    }
    return "uncertain";
  }
}
