import {createHash,randomUUID} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {pool} from './database.js';
import {readBody,sendJson} from './shared.js';
import {readStored,buildTransferStorageKey,storeQuarantined,prepareCleanCopy,removeStored} from './file-storage.js';
import {inspectWechatMedia,sendOfficialMedia,mediaSendDiagnostic,mediaSendFailureOutcome,mediaSendFailureMessage,type MediaSendStage} from './wechat-media-adapter.js';
import {scanWithClamAv} from './file-security.js';
import {getChatwootConversation,getChatwootInbox,createChatwootOutgoingMessage} from './conversation-headless-chatwoot.js';
import {prepareSharedWorkbenchReply} from './shared-wechat-workbench.js';
import {resolveWeChatConnectionById} from './wechat-connection.js';
import {sharedWechatConfig} from './shared-wechat-config.js';
import {ensureConversationMapping} from './conversation-mapping.js';
import {markConversationResponded} from './conversation-attention.js';
import type {WeChatConfig} from './wechat-official.js';
type Auth={tenant_id:string;actor_id:string;platform_user_id:string|null;auth_kind:'console_session'|'api_key'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let active=0;
/** An explicit authenticated manual action. Uploading never implicitly sends. */
export async function handleWechatMediaSend(request:IncomingMessage,response:ServerResponse,url:URL,auth:Auth,requestId:string):Promise<boolean>{
  const match=url.pathname.match(/^\/api\/v1\/conversations\/([0-9a-f-]{36})\/media$/i);if(!match)return false;
  const reply=(status:number,body:Record<string,unknown>)=>sendJson(response,status,{request_id:requestId,...body});
  if(request.method!=='POST'){reply(405,{error:{code:'method_not_allowed'}});return true;}
  if(process.env.WECHAT_MEDIA_ENABLED!=='true'){reply(409,{error:{code:'wechat_media_disabled',message:'公众号媒体发送尚未开放'}});return true;}
  if(auth.auth_kind!=='console_session'||!auth.platform_user_id){reply(403,{error:{code:'console_session_required',message:'仅登录坐席可人工发送媒体'}});return true;}
  if(active>=2){reply(429,{error:{code:'media_busy',message:'媒体发送服务繁忙，请稍后再试'}});return true;}
  const key=String(request.headers['idempotency-key']??'').trim();
  if(key.length<8||key.length>128){reply(400,{error:{code:'idempotency_key_required'}});return true;}
  let input:any;try{input=JSON.parse((await readBody(request)).toString());}catch{}
  if(!input||Array.isArray(input)||Object.keys(input).length!==1||!uuid.test(input.file_transfer_id??'')){reply(400,{error:{code:'invalid_media',message:'请选择已上传并扫描完成的文件'}});return true;}
  const mapping=(await pool.query(`SELECT r.chatwoot_account_id::text account_id,r.chatwoot_resource_id conversation_id FROM conversation_resource_mappings r
    JOIN tenants t ON t.tenant_id=r.tenant_id AND t.chatwoot_account_id=r.chatwoot_account_id AND t.status IN('active','test')
    JOIN tenant_memberships m ON m.tenant_id=t.tenant_id AND m.chatwoot_account_id=t.chatwoot_account_id AND m.platform_user_id=$3 AND m.status='active'
    WHERE r.tenant_id=$1 AND r.replynest_resource_id=$2 AND r.resource_type='conversation'`,[auth.tenant_id,match[1],auth.platform_user_id])).rows[0];
  if(!mapping){reply(404,{error:{code:'conversation_not_found'}});return true;}
  const hash=createHash('sha256').update(JSON.stringify(['wechat-media',match[1],input.file_transfer_id])).digest('hex');
  const command=(await pool.query(`INSERT INTO conversation_message_commands(tenant_id,conversation_replynest_id,platform_user_id,idempotency_key,request_hash)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING command_id`,[auth.tenant_id,match[1],auth.platform_user_id,key,hash])).rows[0];
  if(!command){
    const prior=(await pool.query('SELECT * FROM conversation_message_commands WHERE tenant_id=$1 AND idempotency_key=$2',[auth.tenant_id,key])).rows[0];
    if(prior?.request_hash!==hash)reply(409,{error:{code:'idempotency_key_conflict'}});
    else if(prior.response_status&&prior.response_body)sendJson(response,prior.response_status,prior.response_body);
    else reply(409,{error:{code:'send_outcome_uncertain',message:'发送结果尚未确认，请勿重复发送并联系管理员核查'}});
    return true;
  }
  // The initial check precedes asynchronous DB I/O; enforce the slot again here.
  if(active>=2){
    const body={request_id:requestId,error:{code:'media_busy',message:'媒体发送服务繁忙，请稍后重新选择文件'}};
    await pool.query("UPDATE conversation_message_commands SET state='failed',response_status=429,response_body=$3,error_code='media_busy' WHERE tenant_id=$1 AND command_id=$2",[auth.tenant_id,command.command_id,body]);
    sendJson(response,429,body);return true;
  }
  active++;let providerStarted=false,stage:MediaSendStage='file',clean:string|undefined,quarantine:string|undefined;
  try{
    const file=(await pool.query(`SELECT * FROM conversation_file_transfers WHERE tenant_id=$1 AND transfer_id=$2 AND conversation_replynest_id=$3 AND direction='outbound_download' AND status='ready' AND expires_at>NOW()`,[auth.tenant_id,input.file_transfer_id,match[1]])).rows[0];
    if(!file?.storage_key)throw Error('media_file_unavailable');
    const kind=file.mime_type==='video/mp4'?'video':['image/jpeg','image/png','image/gif'].includes(file.mime_type)?'image':null;
    if(!kind)throw Error('media_file_unsupported');
    const bytes=await readStored(file.storage_key),validated=inspectWechatMedia(kind,bytes);
    if(bytes.length!==Number(file.size_bytes)||kind==='image'&&bytes.length>2*1024*1024)throw Error('media_size_limit');
    stage='scan';if(!(await scanWithClamAv(bytes)).clean)throw Error('media_file_unsafe');
    stage='conversation';
    const conversation=await getChatwootConversation(mapping.account_id,mapping.conversation_id);
    if(String(conversation.id)!==mapping.conversation_id||String(conversation.account_id)!==mapping.account_id||conversation.can_reply!==true)throw Error('media_conversation_unavailable');
    // The gateway is the sole provider sender. A native WeChat inbox could also send the history placeholder.
    const inbox=await getChatwootInbox(mapping.account_id,String(conversation.inbox_id));
    if(String(inbox.id)!==String(conversation.inbox_id)||inbox.channel_type!=='Channel::Api'||inbox.account_id!=null&&String(inbox.account_id)!==mapping.account_id)throw Error('media_inbox_unavailable');
    const shared=await prepareSharedWorkbenchReply(pool,{tenantId:auth.tenant_id,actorId:auth.actor_id,userId:auth.platform_user_id,accountId:mapping.account_id},
      {id:conversation.id,account_id:conversation.account_id,inbox_id:conversation.inbox_id,custom_attributes:conversation.custom_attributes},'',
      {enabled:process.env.SHARED_WECHAT_DELIVERY_ENABLED==='true',manualSendEnabled:process.env.SHARED_WECHAT_MANUAL_SEND_ENABLED==='true'});
    stage='binding';let config:WeChatConfig,openId:string,connectionId:string|null=null;
    if(shared){
      const b=(await pool.query('SELECT open_id FROM shared_wechat_threads WHERE tenant_id=$1 AND app_id=$2 AND account_id::text=$3 AND conversation_id::text=$4',[auth.tenant_id,shared.appId,mapping.account_id,mapping.conversation_id])).rows[0];
      config=await sharedWechatConfig();if(!b||config.appId!==shared.appId)throw Error('media_conversation_unavailable');openId=b.open_id;
    }else{
      if(process.env.WECHAT_LIVE_ENABLED!=='true')throw Error('media_send_disabled');
      const b=(await pool.query(`SELECT i.external_user_id,i.channel_connection_id FROM channel_identities i JOIN channel_connections c ON c.connection_id=i.channel_connection_id AND c.tenant_id=i.tenant_id
        WHERE i.tenant_id=$1 AND i.chatwoot_conversation_id::text=$2 AND i.channel='wechat_official_account' AND c.channel_type=i.channel AND c.status='ready'
        AND c.configuration->>'chatwoot_account_id'=$3 AND c.configuration->>'chatwoot_inbox_id'=$4 LIMIT 2`,[auth.tenant_id,mapping.conversation_id,mapping.account_id,String(conversation.inbox_id)])).rows;
      if(b.length!==1)throw Error('media_conversation_unavailable');
      const conn=await resolveWeChatConnectionById(b[0].channel_connection_id,auth.tenant_id);
      if(!conn||conn.config.appId===process.env.SHARED_WECHAT_APP_ID)throw Error('media_conversation_unavailable');config=conn.config;openId=b[0].external_user_id;connectionId=conn.connectionId;
    }
    const tenant=(await pool.query('SELECT name FROM tenants WHERE tenant_id=$1',[auth.tenant_id])).rows[0];
    // Isolated scanned copy: a relay link expiring in 7 days must not erase conversation media.
    stage='history';const mediaId=randomUUID();quarantine=buildTransferStorageKey(auth.tenant_id,mediaId,validated.extension);
    await storeQuarantined(quarantine,bytes);clean=await prepareCleanCopy(quarantine);await removeStored(quarantine);quarantine=undefined;
    const raw=await createChatwootOutgoingMessage(mapping.account_id,mapping.conversation_id,`[公众号发送] ${kind==='image'?'图片':'视频'} · ${file.file_name}`,command.command_id,false,'wechat_media_manual');
    if(String(raw.conversation_id)!==mapping.conversation_id||(raw.account_id!=null&&String(raw.account_id)!==mapping.account_id)||!/^\d+$/.test(String(raw.id)))throw Error('media_history_mismatch');
    const messageId=await ensureConversationMapping(pool,auth.tenant_id,'message',mapping.account_id,String(raw.id),match[1]);
    const days=Number(process.env.WECHAT_MEDIA_RETENTION_DAYS??180);if(!Number.isInteger(days)||days<1||days>365)throw Error('media_retention_invalid');
    await pool.query(`INSERT INTO wechat_message_media(media_id,tenant_id,account_id,conversation_id,message_id,conversation_replynest_id,app_id,connection_id,descriptor,status,file_name,mime_type,size_bytes,storage_key,expires_at,notified_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10,$11,$12,$13,NOW()+make_interval(days=>$14),NOW())`,[mediaId,auth.tenant_id,mapping.account_id,mapping.conversation_id,String(raw.id),match[1],config.appId,connectionId,{kind,direction:'outgoing'},file.file_name,validated.mimeType,bytes.length,clean,days]);
    clean=undefined;
    await ensureConversationMapping(pool,auth.tenant_id,'attachment',mapping.account_id,`wechat-media:${mediaId}`,messageId);
    await pool.query('UPDATE conversation_message_commands SET upstream_message_id=$3 WHERE tenant_id=$1 AND command_id=$2',[auth.tenant_id,command.command_id,String(raw.id)]);
    // Recheck member and channel/grant before the only provider-side send. No DB lock spans HTTP.
    stage='authorization';const member=await pool.query("SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND platform_user_id=$2 AND chatwoot_account_id::text=$3 AND status='active'",[auth.tenant_id,auth.platform_user_id,mapping.account_id]);
    if(!member.rowCount)throw Error('media_membership_changed');
    if(shared){
      const current=await prepareSharedWorkbenchReply(pool,{tenantId:auth.tenant_id,actorId:auth.actor_id,userId:auth.platform_user_id,accountId:mapping.account_id},conversation as any,'',{enabled:process.env.SHARED_WECHAT_DELIVERY_ENABLED==='true',manualSendEnabled:process.env.SHARED_WECHAT_MANUAL_SEND_ENABLED==='true'});
      if(!current||current.appId!==shared.appId)throw Error('media_connection_changed');
    }
    else {
      const current=await resolveWeChatConnectionById(connectionId!,auth.tenant_id);
      const bound=await pool.query(`SELECT 1 FROM channel_identities i JOIN channel_connections c ON c.connection_id=i.channel_connection_id AND c.tenant_id=i.tenant_id
        JOIN tenants t ON t.tenant_id=i.tenant_id AND t.status IN('active','test')
        WHERE i.tenant_id=$1 AND i.channel_connection_id=$2 AND i.external_user_id=$3 AND i.chatwoot_conversation_id::text=$4
        AND c.status='ready' AND c.configuration->>'chatwoot_account_id'=$5 AND c.configuration->>'chatwoot_inbox_id'=$6`,[auth.tenant_id,connectionId,openId,mapping.conversation_id,mapping.account_id,String(conversation.inbox_id)]);
      if(!current||current.config.appId!==config.appId||!bound.rowCount)throw Error('media_connection_changed');
      config=current.config;
    }
    await pool.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
      VALUES($1,'platform_user',$2,'conversation.media_manual_requested','conversation',$3,$4,$5)`,[auth.tenant_id,auth.platform_user_id,match[1],{command_id:command.command_id,media_kind:kind,size_bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},requestId]);
    stage='send';providerStarted=true;await sendOfficialMedia(config,openId,kind,{bytes,...validated},{shared:Boolean(shared),merchantName:tenant.name});
    stage='record';
    const body={request_id:requestId,data:{command_id:command.command_id,state:'accepted',delivery_state:'wechat_media_provider_accepted'}};
    await pool.query("UPDATE conversation_message_commands SET state='accepted',response_status=202,response_body=$3 WHERE tenant_id=$1 AND command_id=$2",[auth.tenant_id,command.command_id,body]);
    await markConversationResponded(auth.tenant_id,mapping.conversation_id).catch(()=>{});
    reply(202,{data:body.data});
  }catch(error){
    const {uncertain,code}=mediaSendFailureOutcome(error,providerStarted),diagnostic=mediaSendDiagnostic(error,stage);
    const body={request_id:requestId,error:{code,diagnostic,message:mediaSendFailureMessage(code,diagnostic)}};
    await pool.query('UPDATE conversation_message_commands SET state=$3,response_status=$4,response_body=$5,error_code=$6 WHERE tenant_id=$1 AND command_id=$2',[auth.tenant_id,command.command_id,uncertain?'uncertain':'failed',uncertain?503:409,body,code]);
    sendJson(response,uncertain?503:409,body);
  }finally{
    if(clean)await removeStored(clean).catch(()=>{});if(quarantine)await removeStored(quarantine).catch(()=>{});active--;
  }
  return true;
}
