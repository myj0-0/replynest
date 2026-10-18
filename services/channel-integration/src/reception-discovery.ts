import {randomUUID} from 'node:crypto';
import {pool} from './database.js';
import {enqueueConversationReception} from './reception-store.js';
import {ensureSharedWechatCustomer} from './shared-wechat-customer.js';
import {syncWebChatContact} from './web-chat-api.js';
import {getChatwootConversation,listChatwootConversations,listChatwootMessages} from './conversation-headless-chatwoot.js';

/** Repairable source discovery: stable receipts for shared WeChat, bounded native inbox polling for web chat. */
export async function discoverReceptionMessages() {
  if(process.env.AI_RECEPTION_DRAFT_WORKER_ENABLED!=='true')return;
  await pool.query(`INSERT INTO reception_scan_cursors(tenant_id)
    SELECT s.tenant_id FROM tenant_ai_settings s JOIN tenants t USING(tenant_id)
    WHERE s.automation_consent_version='automatic-reply-v1' AND s.ai_auto_reply_enabled AND NOT s.automatic_sending_enabled
      AND t.status IN('active','test') AND NOT EXISTS(SELECT 1 FROM reception_scan_cursors c WHERE c.tenant_id=s.tenant_id)
    ORDER BY s.tenant_id LIMIT 100 ON CONFLICT DO NOTHING`);
  const token=randomUUID();
  const claim=await pool.query(`WITH due AS (
    SELECT c.tenant_id FROM reception_scan_cursors c JOIN tenant_ai_settings s USING(tenant_id) JOIN tenants t USING(tenant_id)
    WHERE c.next_at<=NOW() AND s.automation_consent_version='automatic-reply-v1' AND s.ai_auto_reply_enabled
     AND NOT s.automatic_sending_enabled AND t.status IN('active','test') AND t.chatwoot_account_id IS NOT NULL
    ORDER BY c.next_at,c.tenant_id FOR UPDATE OF c SKIP LOCKED LIMIT 1
   ) UPDATE reception_scan_cursors c SET next_at=NOW()+INTERVAL '5 minutes',worker_token=$1
    FROM due d WHERE c.tenant_id=d.tenant_id RETURNING c.*`,[token]);
  const cursor=claim.rows[0];if(!cursor)return;
  const tenant=(await pool.query('SELECT chatwoot_account_id::text account_id FROM tenants WHERE tenant_id=$1',[cursor.tenant_id])).rows[0];
  let page=cursor.page,offset=cursor.page_offset;
  try {
    const shared=(await pool.query("SELECT to_regclass('shared_wechat_deliveries') IS NOT NULL AS ready")).rows[0].ready;
    if(shared){
      const receipts=await pool.query(`SELECT d.upstream_message_id message_id,b.conversation_id::text conversation_id
       FROM shared_wechat_deliveries d JOIN shared_wechat_threads b ON b.app_id=d.app_id AND b.tenant_id=d.tenant_id AND b.open_id=d.open_id
       JOIN shared_wechat_accounts a ON a.app_id=b.app_id AND a.enabled
       JOIN shared_wechat_enrollments e ON e.app_id=b.app_id AND e.tenant_id=b.tenant_id AND e.enabled
       JOIN shared_wechat_inboxes i ON i.app_id=b.app_id AND i.tenant_id=b.tenant_id AND i.account_id=b.account_id AND i.inbox_id=b.inbox_id AND i.enabled
       JOIN tenant_ai_settings s ON s.tenant_id=d.tenant_id
       WHERE d.tenant_id=$1 AND b.account_id::text=$2 AND d.direction='in' AND d.status='delivered'
        AND d.created_at>=s.automation_updated_at AND d.created_at>NOW()-INTERVAL '10 minutes'
        AND NOT EXISTS(SELECT 1 FROM reception_jobs j WHERE j.tenant_id=d.tenant_id AND j.account_id=$2 AND j.message_id=d.upstream_message_id)
       ORDER BY d.created_at,d.command_id LIMIT 10`,[cursor.tenant_id,tenant.account_id]);
      for(const r of receipts.rows){
        await ensureSharedWechatCustomer(pool,cursor.tenant_id,r.conversation_id);
        await enqueueConversationReception(pool,{tenantId:cursor.tenant_id,accountId:tenant.account_id,conversationId:r.conversation_id,messageId:r.message_id,channel:'shared_wechat'});
      }
    }
    const channels=await pool.query(`SELECT configuration->>'chatwoot_inbox_id' inbox_id FROM channel_connections
      WHERE tenant_id=$1 AND channel_type='web_chat' AND status='ready' AND configuration->>'chatwoot_account_id'=$2 LIMIT 100`,[cursor.tenant_id,tenant.account_id]);
    if(channels.rowCount){
      const inboxes=new Set(channels.rows.map(c=>String(c.inbox_id)));
      const conversations=await listChatwootConversations(tenant.account_id,page,'all');
      for(const raw of conversations.slice(offset,offset+5)){
        if(!inboxes.has(String(raw.inbox_id))||!/^\d+$/.test(String(raw.id)))continue;
        const c=await getChatwootConversation(tenant.account_id,String(raw.id));
        if(String(c.account_id)!==tenant.account_id||String(c.id)!==String(raw.id)||!inboxes.has(String(c.inbox_id)))continue;
        await syncWebChatContact(cursor.tenant_id,tenant.account_id,c);
        const messages=await listChatwootMessages(tenant.account_id,String(c.id));
        const relevant=messages.filter(m=>m.private===false&&[0,1,'incoming','outgoing'].includes(m.message_type as number|string)&&/^\d+$/.test(String(m.id)));
        relevant.sort((a,b)=>BigInt(String(a.id))>BigInt(String(b.id))?-1:1);
        const m=relevant[0];if(!m||![0,'incoming'].includes(m.message_type as number|string)||String(m.conversation_id)!==String(c.id))continue;
        if(m.account_id!=null&&String(m.account_id)!==tenant.account_id)continue;
        const created=typeof m.created_at==='number'?m.created_at*1000:Date.parse(String(m.created_at));
        if(!Number.isFinite(created)||Date.now()-created>600000)continue;
        await enqueueConversationReception(pool,{tenantId:cursor.tenant_id,accountId:tenant.account_id,conversationId:String(c.id),messageId:String(m.id),channel:'web_chat'});
      }
      offset+=5;
      if(!conversations.length){page=1;offset=0;}else if(offset>=conversations.length){page=page>=10000?1:page+1;offset=0;}
    }
  }finally{
    await pool.query(`UPDATE reception_scan_cursors SET page=$3,page_offset=$4,next_at=NOW()+INTERVAL '10 seconds'
      WHERE tenant_id=$1 AND worker_token=$2`,[cursor.tenant_id,token,page,offset]);
  }
}
