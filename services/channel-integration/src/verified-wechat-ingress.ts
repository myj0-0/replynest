import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import type {InboundJob} from './inbound-queue.js';
import type {createVerifiedWeChatIngressClient,VerifiedWeChatIngress} from './verified-wechat-ingress-client.js';
type Port=ReturnType<typeof createVerifiedWeChatIngressClient>;
/** Only a leased, verified independent callback event can select native addresses.
 * No global inbox or public SDK fallback. Native provider-event dedup is durable;
 * unknown acknowledgements may be reconciled by the SAME immutable event later.
 */
export async function projectVerifiedWeChatInbound(db:Pick<Pool,'connect'>,job:InboundJob,client:Port){
 const c=await db.connect();let input:VerifiedWeChatIngress;
 try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms'");
  const row=(await c.query(`SELECT e.id,e.tenant_id,e.channel_connection_id,e.external_event_id,e.external_message_id,e.payload->'normalized' n,
    t.chatwoot_account_id::text account_id,conn.external_account_id app_id,conn.configuration->>'chatwoot_inbox_id' inbox_id
   FROM gateway_events e JOIN tenants t ON t.tenant_id=e.tenant_id
   JOIN channel_connections conn ON conn.connection_id=e.channel_connection_id AND conn.tenant_id=e.tenant_id
   WHERE e.id=$1::bigint AND e.tenant_id=$2 AND e.worker_id=$3 AND e.status='processing' AND e.locked_at>NOW()-INTERVAL '60 seconds'
    AND e.channel='wechat_official_account' AND e.channel_connection_id=$4::uuid AND t.status IN('active','test')
    AND conn.channel_type=e.channel AND conn.status='ready' AND conn.configuration->>'chatwoot_account_id'=t.chatwoot_account_id::text
    AND NOT EXISTS(SELECT 1 FROM shared_wechat_accounts a WHERE a.app_id=conn.external_account_id AND a.enabled)
   FOR SHARE OF e,t,conn`,[job.id,job.tenant_id,job.worker_id,job.channel_connection_id])).rows[0];
  if(!row||job.channel!=='wechat_official_account'||row.external_event_id!==job.external_event_id||row.external_message_id!==job.external_message_id||
   row.n?.event_id!==row.external_event_id||row.n?.message_id!==row.external_message_id)throw Error('invalid_inbound_job');
  // gateway_events uses BIGSERIAL, not UUID. Derive a stable server-side UUIDv8
  // from the immutable row/tenant/connection tuple; retries keep the same command.
  const hex=createHash('sha256').update(JSON.stringify(['replynest-verified-ingress-v1',String(row.id),row.tenant_id,row.channel_connection_id])).digest('hex').slice(0,32);
  const commandId=`${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-${((parseInt(hex[16],16)&3)|8).toString(16)}${hex.slice(17,20)}-${hex.slice(20)}`;
  input={commandId,accountId:row.account_id,inboxId:row.inbox_id,connectionId:row.channel_connection_id,appId:row.app_id,openId:row.n.user_id,
   sourceEventId:row.external_event_id,externalMessageId:row.external_message_id,sourceOccurredAt:row.n.occurred_at,content:row.n.text};
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 const result=await client.project(input);
 if(result.outcome!=='accepted')throw Error(result.outcome==='rejected'?'verified_ingress_rejected':'verified_ingress_uncertain');
 const validId=(v:unknown)=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
 if(result.accountId!==input.accountId||result.inboxId!==input.inboxId||![result.contactId,result.conversationId,result.messageId].every(validId)||
  typeof result.sourceId!=='string'||!result.sourceId.trim()||result.sourceId.length>200||result.sourceId.includes('\0'))throw Error('verified_ingress_binding_mismatch');
 // Native commit and business commit are separate. Replay cannot create a second
 // native message; identity mismatch fails closed rather than silently rewriting it.
 const write=await db.connect();try{
  await write.query('BEGIN');await write.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms'");
  await write.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${job.tenant_id}:wechat_official_account:${input.connectionId}:${input.openId}`]);
  const still=(await write.query(`SELECT e.id FROM gateway_events e JOIN tenants t ON t.tenant_id=e.tenant_id JOIN channel_connections conn
   ON conn.connection_id=e.channel_connection_id AND conn.tenant_id=e.tenant_id
   WHERE e.id=$1::bigint AND e.worker_id=$2 AND e.status='processing' AND e.locked_at>NOW()-INTERVAL '60 seconds' AND e.tenant_id=$3 AND t.status IN('active','test')
    AND t.chatwoot_account_id::text=$4 AND conn.status='ready' AND conn.external_account_id=$5
    AND conn.configuration->>'chatwoot_inbox_id'=$6 AND conn.configuration->>'chatwoot_account_id'=$4 AND conn.channel_type='wechat_official_account'
    AND e.external_event_id=$7 AND e.external_message_id=$8 AND e.payload->'normalized'->>'text'=$9
    AND e.payload->'normalized'->>'occurred_at'=$10 AND e.payload->'normalized'->>'user_id'=$11
    AND NOT EXISTS(SELECT 1 FROM shared_wechat_accounts a WHERE a.app_id=conn.external_account_id AND a.enabled)
   FOR SHARE OF e,t,conn`,[job.id,job.worker_id,job.tenant_id,input.accountId,input.appId,input.inboxId,input.sourceEventId,input.externalMessageId,input.content,input.sourceOccurredAt,input.openId])).rows[0];
  if(!still)throw Error('inbound_job_lease_lost');
  const old=(await write.query(`SELECT * FROM channel_identities WHERE tenant_id=$1 AND channel='wechat_official_account'
   AND channel_connection_id=$2 AND external_user_id=$3 FOR UPDATE`,[job.tenant_id,input.connectionId,input.openId])).rows[0];
  if(old&&(String(old.chatwoot_contact_id)!==result.contactId||String(old.chatwoot_conversation_id)!==result.conversationId||old.chatwoot_source_id!==result.sourceId))throw Error('verified_ingress_identity_conflict');
  if(!old){
   const customer=(await write.query(`INSERT INTO customers(tenant_id,name,attributes) VALUES($1,'微信访客','{"source_channel":"wechat_official_account"}') RETURNING customer_id`,[job.tenant_id])).rows[0];
   await write.query(`INSERT INTO channel_identities(tenant_id,customer_id,channel,channel_connection_id,external_user_id,chatwoot_contact_id,chatwoot_source_id,chatwoot_conversation_id)
    VALUES($1,$2,'wechat_official_account',$3,$4,$5,$6,$7)`,[job.tenant_id,customer.customer_id,input.connectionId,input.openId,result.contactId,result.sourceId,result.conversationId]);
  }else await write.query('UPDATE customers SET last_seen_at=NOW(),updated_at=NOW() WHERE tenant_id=$1 AND customer_id=$2',[job.tenant_id,old.customer_id]);
  await write.query('COMMIT');return {id:result.messageId,conversationId:result.conversationId};
 }catch(e){await write.query('ROLLBACK').catch(()=>{});throw e;}finally{write.release();}
}
