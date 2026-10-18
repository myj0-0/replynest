import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {DatabaseComponent} from './database-runtime.js';
import type {WeChatMedia} from './wechat-media-core.js';
import {ensureConversationMapping} from './conversation-mapping.js';
import {downloadOfficialMedia} from './wechat-media-adapter.js';
import type {WeChatConfig} from './wechat-official.js';
import {buildTransferStorageKey,storeQuarantined,prepareCleanCopy,removeStored} from './file-storage.js';
import {scanWithClamAv} from './file-security.js';
import {recordInboundAttention} from './conversation-attention.js';
import {playableWechatVoice} from './wechat-voice-transcoder.js';
export const wechatMediaSchema=`
 CREATE TABLE IF NOT EXISTS wechat_message_media(
  media_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  account_id TEXT NOT NULL,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,
  conversation_replynest_id UUID NOT NULL REFERENCES conversation_resource_mappings(replynest_resource_id),
  app_id TEXT NOT NULL,connection_id UUID,descriptor JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','processing','ready','failed','expired')),
  attempts INTEGER NOT NULL DEFAULT 0,worker_token UUID,available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),locked_at TIMESTAMPTZ,
  file_name TEXT,mime_type TEXT,size_bytes INTEGER,storage_key TEXT,
  notified_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id,account_id,message_id)
 );
 CREATE INDEX IF NOT EXISTS wechat_media_pending ON wechat_message_media(available_at,media_id) WHERE status='pending';
 CREATE INDEX IF NOT EXISTS wechat_media_processing ON wechat_message_media(locked_at) WHERE status='processing';
 CREATE INDEX IF NOT EXISTS wechat_media_expiry ON wechat_message_media(expires_at,media_id) WHERE status<>'expired';
 CREATE INDEX IF NOT EXISTS wechat_media_notification ON wechat_message_media(created_at,media_id) WHERE notified_at IS NULL;
 ALTER TABLE conversation_attention ADD COLUMN IF NOT EXISTS media_notice JSONB;
`;
export function wechatMediaComponent():DatabaseComponent{return {name:'wechat_media',sql:wechatMediaSchema,migrate:async()=>{throw Error('wechat_media_owner_migration_required');}};}
export async function queueWechatMedia(db:Pick<PoolClient,'query'>,input:{tenantId:string;accountId:string;conversationId:string;messageId:string;appId:string;connectionId?:string|null;media:WeChatMedia}){
  if(process.env.WECHAT_MEDIA_ENABLED!=='true')return;
  const days=Number(process.env.WECHAT_MEDIA_RETENTION_DAYS??180);
  if(!Number.isInteger(days)||days<1||days>365)throw Error('wechat_media_retention_invalid');
  const conversation=await ensureConversationMapping(db,input.tenantId,'conversation',input.accountId,input.conversationId);
  const message=await ensureConversationMapping(db,input.tenantId,'message',input.accountId,input.messageId,conversation);
  const result=await db.query(`INSERT INTO wechat_message_media(tenant_id,account_id,conversation_id,message_id,conversation_replynest_id,app_id,connection_id,descriptor,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()+make_interval(days=>$9)) ON CONFLICT(tenant_id,account_id,message_id) DO NOTHING RETURNING media_id,created_at`,
    [input.tenantId,input.accountId,input.conversationId,input.messageId,conversation,input.appId,input.connectionId??null,input.media,days]);
  const media=result.rows[0]??(await db.query('SELECT media_id,created_at FROM wechat_message_media WHERE tenant_id=$1 AND account_id=$2 AND message_id=$3',[input.tenantId,input.accountId,input.messageId])).rows[0];
  if(media){
    const attachment=await ensureConversationMapping(db,input.tenantId,'attachment',input.accountId,`wechat-media:${media.media_id}`,message);
    return {messageId:`wechat-media-${media.media_id}`,occurredAt:new Date(media.created_at).toISOString(),notice:{message_type:input.media.kind,attachment_count:1,view_path:`/workbench?conversation=${conversation}`,attachment_id:attachment}};
  }
}
/** Bounded read-only provider calls; no tenant/receipt lock is held over a download or scan. */
export async function processWechatMedia(db:Pool,resolve:(row:{tenant_id:string;app_id:string;connection_id:string|null;account_id:string;conversation_id:string})=>Promise<WeChatConfig>,deps:{download?:typeof downloadOfficialMedia;scan?:typeof scanWithClamAv;voice?:typeof playableWechatVoice;store?:typeof storeQuarantined;copy?:typeof prepareCleanCopy;remove?:typeof removeStored}={}){
  const token=randomUUID();
  await db.query(`WITH old AS(SELECT media_id FROM wechat_message_media WHERE status='processing' AND locked_at<NOW()-INTERVAL '2 minutes'
   ORDER BY locked_at LIMIT 10 FOR UPDATE SKIP LOCKED) UPDATE wechat_message_media m SET status=CASE WHEN attempts>=6 THEN 'failed' ELSE 'pending' END FROM old WHERE m.media_id=old.media_id`);
  const claim=await db.query(`WITH due AS(SELECT media_id FROM wechat_message_media WHERE status='pending' AND available_at<=NOW() AND expires_at>NOW()
    ORDER BY available_at,media_id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE wechat_message_media m SET status='processing',attempts=attempts+1,worker_token=$1,locked_at=NOW() FROM due WHERE m.media_id=due.media_id RETURNING m.*`,[token]);
  const row=claim.rows[0];if(!row)return false;
  let clean:string|undefined,quarantine:string|undefined;
  try{
    const config=await resolve(row);if(config.appId!==row.app_id)throw Error('wechat_media_account_changed');
    let file=await (deps.download??downloadOfficialMedia)(config,row.descriptor);
    if(!(await (deps.scan??scanWithClamAv)(file.bytes)).clean)throw Error('wechat_media_infected');
    if(row.descriptor.kind==='voice'){
      const converted=await (deps.voice??playableWechatVoice)(file);
      if(converted!==file&&!(await (deps.scan??scanWithClamAv)(converted.bytes)).clean)throw Error('wechat_media_infected');
      file=converted;
    }
    // Recheck gates after a potentially slow network/scan, before releasing a clean asset.
    if((await resolve(row)).appId!==row.app_id)throw Error('wechat_media_account_changed');
    quarantine=buildTransferStorageKey(row.tenant_id,`${row.media_id}-${token}`,file.extension);
    await (deps.store??storeQuarantined)(quarantine,file.bytes);clean=await (deps.copy??prepareCleanCopy)(quarantine);await (deps.remove??removeStored)(quarantine);quarantine=undefined;
    const saved=await db.query(`UPDATE wechat_message_media SET status='ready',file_name=$3,mime_type=$4,size_bytes=$5,storage_key=$6,worker_token=NULL
      WHERE media_id=$1 AND worker_token=$2 AND status='processing' AND expires_at>NOW() RETURNING media_id`,[row.media_id,token,file.fileName,file.mimeType,file.bytes.length,clean]);
    if(!saved.rowCount)throw Error('wechat_media_lease_lost');clean=undefined;
  }catch{
    if(clean)await (deps.remove??removeStored)(clean).catch(()=>{});if(quarantine)await (deps.remove??removeStored)(quarantine).catch(()=>{});
    await db.query(`UPDATE wechat_message_media SET status=CASE WHEN attempts>=6 THEN 'failed' ELSE 'pending' END,available_at=NOW()+INTERVAL '30 seconds',worker_token=NULL WHERE media_id=$1 AND worker_token=$2 AND status='processing'`,[row.media_id,token]);
  }
  return true;
}
export async function expireWechatMedia(db:Pool){
  await db.query(`WITH due AS(SELECT media_id FROM wechat_message_media WHERE expires_at<=NOW() AND status<>'expired' ORDER BY expires_at,media_id LIMIT 20 FOR UPDATE SKIP LOCKED)
    UPDATE wechat_message_media m SET status='expired' FROM due WHERE m.media_id=due.media_id RETURNING m.media_id,m.storage_key`);
  const cleanup=await db.query("SELECT media_id,storage_key FROM wechat_message_media WHERE status='expired' AND storage_key IS NOT NULL ORDER BY expires_at,media_id LIMIT 20");
  for(const row of cleanup.rows)if(row.storage_key){await removeStored(row.storage_key);await db.query("UPDATE wechat_message_media SET storage_key=NULL WHERE media_id=$1 AND status='expired'",[row.media_id]);}
}
export async function publishWechatMediaNotifications(db:Pool){
  const rows=await db.query("SELECT m.* FROM wechat_message_media m JOIN tenants t ON t.tenant_id=m.tenant_id AND t.chatwoot_account_id::text=m.account_id AND t.status IN('active','test') WHERE m.notified_at IS NULL AND m.status IN('ready','failed','expired') AND m.descriptor->>'direction' IS DISTINCT FROM 'outgoing' ORDER BY m.created_at,m.media_id LIMIT 10");
  for(const row of rows.rows){
    const attachment=(await db.query("SELECT replynest_resource_id FROM conversation_resource_mappings WHERE tenant_id=$1 AND chatwoot_account_id=$2 AND resource_type='attachment' AND chatwoot_resource_id=$3",[row.tenant_id,row.account_id,`wechat-media:${row.media_id}`])).rows[0];
    await recordInboundAttention({tenant_id:row.tenant_id,conversation_id:row.conversation_id,message_id:`wechat-media-${row.media_id}`,
      text:`客户发送了${{image:'图片',video:'视频',voice:'语音'}[row.descriptor.kind as WeChatMedia['kind']]}${row.status==='ready'?'':'（未通过安全处理或已过期，请在工作台核查）'}`,media:{message_type:row.descriptor.kind,attachment_count:1,view_path:`/workbench?conversation=${row.conversation_replynest_id}`,attachment_id:attachment?.replynest_resource_id,processing_status:row.status},occurred_at:row.created_at});
    await db.query('UPDATE wechat_message_media SET notified_at=NOW() WHERE media_id=$1 AND notified_at IS NULL',[row.media_id]);
  }
}
