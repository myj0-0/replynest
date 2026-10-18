import {randomUUID} from 'node:crypto';
import {pool} from './database.js';
import {recordReceptionEvent,enqueueConversationReception} from './reception-store.js';
import {getChatwootConversation,listChatwootMessages} from './conversation-headless-chatwoot.js';
import {ensureSharedWechatCustomer} from './shared-wechat-customer.js';
import {syncWebChatContact} from './web-chat-api.js';
import {mediaOnlyMessage} from './wechat-media-core.js';

/** Bounded backlog signal: counts cap at 1001; never aggregate all historical jobs. */
export async function receptionEventBacklog(){
  const result=await pool.query(`SELECT
    (SELECT count(*)::int FROM (SELECT 1 FROM reception_events WHERE state='pending' LIMIT 1001) p) pending_capped,
    COALESCE((SELECT GREATEST(0,EXTRACT(EPOCH FROM NOW()-available_at))::int FROM reception_events
      WHERE state='pending' ORDER BY available_at,event_id LIMIT 1),0) overdue_seconds`);
  return result.rows[0];
}

/** Only invoked AFTER the dedicated bridge HMAC has been verified. Never accepts a tenant ID. */
export async function acceptReceptionCallback(payload:any):Promise<void>{
  if(payload?.event!=='message_created'||payload.private!==false||![0,'incoming'].includes(payload.message_type))return;
  const account=String(payload.account?.id??''),conversation=String(payload.conversation?.id??''),message=String(payload.id??''),inbox=String(payload.inbox?.id??payload.conversation?.inbox_id??'');
  if(![account,conversation,message,inbox].every(v=>/^[1-9]\d{0,18}$/.test(v)))throw new Error('invalid_reception_identifiers');
  // Native web inbox ownership is server-side configuration, not a webhook-provided tenant.
  const bindings=await pool.query(`SELECT c.tenant_id FROM channel_connections c JOIN tenants t USING(tenant_id)
    WHERE c.channel_type='web_chat' AND c.status='ready' AND t.status IN('active','test')
    AND t.chatwoot_account_id::text=$1 AND c.configuration->>'chatwoot_account_id'=$1
    AND c.configuration->>'chatwoot_inbox_id'=$2 LIMIT 2`,[account,inbox]);
  if(bindings.rows.length!==1)return;
  await recordReceptionEvent(pool,{tenantId:bindings.rows[0].tenant_id,accountId:account,conversationId:conversation,messageId:message,inboxId:inbox,channel:'web_chat'});
}

/** Retry only source verification/materialization, never a model request or external send. */
export async function processReceptionEvent():Promise<boolean>{
  if(process.env.AI_RECEPTION_DRAFT_WORKER_ENABLED!=='true')return false;
  await pool.query(`WITH stale AS(SELECT event_id FROM reception_events WHERE state='processing' AND locked_at<NOW()-INTERVAL '2 minutes'
    ORDER BY locked_at FOR UPDATE SKIP LOCKED LIMIT 100)
    UPDATE reception_events e SET state=CASE WHEN attempts>=8 THEN 'failed' ELSE 'pending' END,
      available_at=NOW(),reason='verification_interrupted' FROM stale s WHERE s.event_id=e.event_id`);
  const token=randomUUID();
  const claimed=await pool.query(`WITH due AS(SELECT event_id FROM reception_events WHERE state='pending' AND available_at<=NOW()
    ORDER BY available_at,event_id FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE reception_events e SET state='processing',worker_token=$1,locked_at=NOW(),attempts=attempts+1
    FROM due d WHERE e.event_id=d.event_id RETURNING e.*`,[token]);
  const e=claimed.rows[0];if(!e)return false;
  const finish=async(reason:string)=>pool.query("UPDATE reception_events SET state='done',reason=$3 WHERE event_id=$1 AND worker_token=$2 AND state='processing'",[e.event_id,token,reason]);
  try{
    const consent=await pool.query(`SELECT 1 FROM reception_events e JOIN tenant_ai_settings s USING(tenant_id) JOIN tenants t USING(tenant_id)
      WHERE e.event_id=$1 AND s.automation_updated_at=e.authorization_at AND s.ai_auto_reply_enabled AND NOT s.automatic_sending_enabled
      AND s.automation_consent_version='automatic-reply-v1' AND t.status IN('active','test') AND t.chatwoot_account_id::text=e.account_id`,[e.event_id]);
    if(!consent.rowCount){await finish('authorization_changed');return true;}
    const c=await getChatwootConversation(e.account_id,e.conversation_id);
    if(String(c.account_id)!==e.account_id||String(c.id)!==e.conversation_id||String(c.inbox_id)!==e.inbox_id){await finish('source_boundary_mismatch');return true;}
    const messages=await listChatwootMessages(e.account_id,e.conversation_id);
    const m=messages.find(m=>String(m.id)===e.message_id);
    if(!m)throw new Error('message_not_visible_yet');
    if(mediaOnlyMessage(m)){await finish('media_requires_human');return true;}
    if(m.private!==false||![0,'incoming'].includes(m.message_type as string|number)||String(m.conversation_id)!==e.conversation_id||(m.account_id!=null&&String(m.account_id)!==e.account_id)){
      await finish('not_public_customer_message');return true;
    }
    if(e.channel==='web_chat')await syncWebChatContact(e.tenant_id,e.account_id,c);
    else await ensureSharedWechatCustomer(pool,e.tenant_id,e.conversation_id);
    const identity=await pool.query(`SELECT 1 FROM channel_identities WHERE tenant_id=$1 AND channel=$2
      AND chatwoot_conversation_id::text=$3 AND customer_id IS NOT NULL LIMIT 1`,[e.tenant_id,e.channel,e.conversation_id]);
    if(!identity.rowCount)throw new Error('customer_projection_not_ready');
    const tx=await pool.connect();
    try{
      await tx.query('BEGIN');
      // Lock both the lease and authorization until the downstream enqueue commits.
      const valid=await tx.query(`SELECT 1 FROM reception_events e JOIN tenant_ai_settings s USING(tenant_id)
        WHERE e.event_id=$1 AND e.worker_token=$2 AND e.state='processing' AND s.automation_updated_at=e.authorization_at
        FOR UPDATE OF e FOR SHARE OF s`,[e.event_id,token]);
      if(valid.rowCount){
        await enqueueConversationReception(tx,{tenantId:e.tenant_id,accountId:e.account_id,conversationId:e.conversation_id,messageId:e.message_id,channel:e.channel});
        await tx.query("UPDATE reception_events SET state='done',reason='verified' WHERE event_id=$1",[e.event_id]);
      }else await tx.query("UPDATE reception_events SET state='done',reason='authorization_changed' WHERE event_id=$1 AND worker_token=$2 AND state='processing'",[e.event_id,token]);
      await tx.query('COMMIT');
    }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
  }catch{
    await pool.query(`UPDATE reception_events SET state=CASE WHEN attempts>=8 THEN 'failed' ELSE 'pending' END,
      reason='source_verification_unavailable',available_at=NOW()+make_interval(secs=>LEAST(300,5*attempts*attempts))
      WHERE event_id=$1 AND worker_token=$2 AND state='processing'`,[e.event_id,token]);
  }
  return true;
}
