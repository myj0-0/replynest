import {createHash,randomUUID} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {pool} from './database.js';
import {readBody,sendJson} from './shared.js';
import {canManageQuickReplies} from './quick-reply-permissions.js';
import {readSingleFileMultipart} from './multipart-upload.js';
import {scanWithClamAv,validateTransferFile} from './file-security.js';
import {inspectWechatMedia} from './wechat-media-adapter.js';
import {buildTransferStorageKey,storeQuarantined,prepareCleanCopy,removeStored,readStored} from './file-storage.js';
import {isQuickReplyUuid,quickReplyImageEnabled,quickReplyTransferId} from './quick-reply-images-core.js';

export type QuickReplyImageAuth={tenant_id:string;role:string;actor_id:string;platform_user_id:string|null;auth_kind:string;impersonation_id?:string|null;session_scope?:string|null};
type ImageRow={asset_id:string;file_name:string;mime_type:string;size_bytes:number;storage_key:string;sha256:string};
export const imageView=(row:ImageRow)=>({asset_id:row.asset_id,file_name:row.file_name,mime_type:row.mime_type,size_bytes:row.size_bytes,preview_url:`/api/quick-reply-images/${row.asset_id}/content`});
async function member(auth:QuickReplyImageAuth,manage=false){
 if(auth.auth_kind!=='console_session'||!auth.platform_user_id||auth.impersonation_id||auth.session_scope==='copilot_embed')throw Error('console_session_required');
 const found=await pool.query(`SELECT t.tenant_id FROM tenants t JOIN tenant_memberships m ON m.tenant_id=t.tenant_id AND m.chatwoot_account_id=t.chatwoot_account_id
 WHERE t.tenant_id=$1 AND t.status IN('active','test') AND m.platform_user_id=$2 AND m.status='active'
 AND ($3::boolean=false OR m.role IN('tenant_admin','supervisor'))`,[auth.tenant_id,auth.platform_user_id,manage]);
 if(!found.rowCount||manage&&!canManageQuickReplies(auth))throw Error('manager_required');
}
let uploading=0;
export async function handleQuickReplyImagesApi(request:IncomingMessage,response:ServerResponse,url:URL,auth:QuickReplyImageAuth,requestId:string){
 const collection=url.pathname==='/api/v1/quick-reply-images';
 const content=url.pathname.match(/^\/api\/v1\/quick-reply-images\/([0-9a-f-]{36})\/content$/i);
 const prepare=url.pathname.match(/^\/api\/v1\/quick-replies\/([0-9a-f-]{36})\/prepare-image$/i);
 if(!collection&&!content&&!prepare)return false;
 const reply=(status:number,body:Record<string,unknown>)=>sendJson(response,status,{request_id:requestId,...body});
 if(!quickReplyImageEnabled()){reply(409,{error:{code:'quick_reply_images_disabled',message:'图片快捷回复尚未开放'}});return true;}
 let quarantine:string|undefined,clean:string|undefined,slot=false;
 try{
  await member(auth,collection);
  if(collection&&request.method==='POST'){
   if(uploading>=2)throw Error('image_busy');uploading++;slot=true;
   const file=await readSingleFileMultipart(request,2*1024*1024),format=validateTransferFile(file.filename,file.mimeType,file.data);
   const actual=inspectWechatMedia('image',file.data);
   if(!['image/jpeg','image/png','image/gif'].includes(format.mimeType)||format.mimeType!==actual.mimeType)throw Error('invalid_image');
   if(!(await scanWithClamAv(file.data)).clean)throw Error('image_unsafe');
   await member(auth,true);const digest=createHash('sha256').update(file.data).digest('hex');
   const id=randomUUID();quarantine=buildTransferStorageKey(auth.tenant_id,`quick-reply-${id}`,actual.extension);
   await storeQuarantined(quarantine,file.data);clean=await prepareCleanCopy(quarantine);await removeStored(quarantine);quarantine=undefined;
   const c=await pool.connect();let image:ImageRow,discardOld:string|undefined;
   try{
    await c.query('BEGIN');const tenant=await c.query("SELECT tenant_id FROM tenants WHERE tenant_id=$1 AND status IN('active','test') FOR UPDATE",[auth.tenant_id]);if(!tenant.rowCount)throw Error('manager_required');
    const active=await c.query("SELECT 1 FROM tenant_memberships m JOIN tenants t ON t.tenant_id=m.tenant_id AND t.chatwoot_account_id=m.chatwoot_account_id WHERE m.tenant_id=$1 AND m.platform_user_id=$2 AND m.status='active' AND m.role IN('tenant_admin','supervisor')",[auth.tenant_id,auth.platform_user_id]);if(!active.rowCount)throw Error('manager_required');
    const prior=(await c.query<ImageRow>("SELECT * FROM tenant_quick_reply_images WHERE tenant_id=$1 AND sha256=$2 AND status='ready' FOR UPDATE",[auth.tenant_id,digest])).rows[0];
    let replacePrior=false;
    if(prior){
     image=prior;
     await c.query('UPDATE tenant_quick_reply_images SET orphaned_at=CASE WHEN orphaned_at IS NULL THEN NULL ELSE NOW() END WHERE tenant_id=$1 AND asset_id=$2',[auth.tenant_id,prior.asset_id]);
     // Re-uploading identical bytes can repair missing/corrupt library storage.
     const stored=await readStored(prior.storage_key).catch(()=>null);
     if(!stored||stored.length!==Number(prior.size_bytes)||createHash('sha256').update(stored).digest('hex')!==digest){
      await c.query('UPDATE tenant_quick_reply_images SET storage_key=$3 WHERE tenant_id=$1 AND asset_id=$2',[auth.tenant_id,prior.asset_id,clean]);
      discardOld=prior.storage_key;replacePrior=true;image={...prior,storage_key:clean};
     }
    }
    else{
     const usage=(await c.query("SELECT count(*)::int n,COALESCE(sum(size_bytes),0)::bigint bytes FROM tenant_quick_reply_images WHERE tenant_id=$1 AND status='ready'",[auth.tenant_id])).rows[0];if(usage.n>=200||Number(usage.bytes)+file.data.length>20*1024*1024)throw Error('image_quota');
     image=(await c.query<ImageRow>(`INSERT INTO tenant_quick_reply_images(asset_id,tenant_id,file_name,mime_type,size_bytes,sha256,storage_key,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[id,auth.tenant_id,file.filename,actual.mimeType,file.data.length,digest,clean,auth.platform_user_id])).rows[0];
    }
    await c.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
     VALUES($1,'platform_user',$2,'quick_reply.image_uploaded','quick_reply_image',$3,$4,$5)`,[auth.tenant_id,auth.platform_user_id,image.asset_id,{size_bytes:file.data.length,sha256:digest},requestId]);
    await c.query('COMMIT');if(!prior||replacePrior)clean=undefined;
   }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
   if(discardOld)await removeStored(discardOld).catch(()=>{});
   reply(201,{data:imageView(image!)});return true;
  }
  if(content&&request.method==='GET'){
   const image=(await pool.query<ImageRow>(`SELECT i.* FROM tenant_quick_reply_images i WHERE i.tenant_id=$1 AND i.asset_id=$2 AND i.status='ready'
    AND (($3::boolean AND EXISTS(SELECT 1 FROM tenant_memberships m WHERE m.tenant_id=i.tenant_id AND m.platform_user_id=$4 AND m.status='active' AND m.role IN('tenant_admin','supervisor')))
    OR EXISTS(SELECT 1 FROM tenant_quick_replies q WHERE q.tenant_id=i.tenant_id AND q.image_asset_id=i.asset_id AND q.status='active'))`,[auth.tenant_id,content[1],canManageQuickReplies(auth),auth.platform_user_id])).rows[0];
   if(!image)throw Error('image_not_found');const bytes=await readStored(image.storage_key);
   if(bytes.length!==Number(image.size_bytes)||createHash('sha256').update(bytes).digest('hex')!==image.sha256)throw Error('image_unavailable');
   response.writeHead(200,{'content-type':image.mime_type,'content-length':bytes.length,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'referrer-policy':'no-referrer'});response.end(bytes);return true;
  }
  if(prepare&&request.method==='POST'){
   if(uploading>=2)throw Error('image_busy');uploading++;slot=true;
   const body=JSON.parse((await readBody(request)).toString('utf8'));
   if(!body||Object.keys(body).sort().join(',')!=='conversation_id,image_asset_id,updated_at'||!isQuickReplyUuid(body.conversation_id)||!isQuickReplyUuid(body.image_asset_id)||typeof body.updated_at!=='string'||body.updated_at.length>40)throw Error('invalid_image');
   const key=String(request.headers['idempotency-key']??'');if(key.length<8||key.length>128)throw Error('invalid_image');
   const data=(await pool.query<ImageRow&{updated_at:Date;channel:string}>(`SELECT i.*,q.updated_at,c.channel FROM tenant_quick_replies q
    JOIN tenant_quick_reply_images i ON i.tenant_id=q.tenant_id AND i.asset_id=q.image_asset_id AND i.status='ready'
    JOIN tenants t ON t.tenant_id=q.tenant_id AND t.status IN('active','test')
    JOIN conversation_resource_mappings r ON r.tenant_id=t.tenant_id AND r.chatwoot_account_id=t.chatwoot_account_id AND r.resource_type='conversation' AND r.replynest_resource_id=$3
    JOIN channel_identities c ON c.tenant_id=r.tenant_id AND c.chatwoot_conversation_id::text=r.chatwoot_resource_id
    WHERE q.tenant_id=$1 AND q.quick_reply_id=$2 AND q.status='active' AND i.asset_id=$4 LIMIT 2`,[auth.tenant_id,prepare[1],body.conversation_id,body.image_asset_id])).rows;
   if(data.length!==1)throw Error('image_not_found');const image=data[0];
   if(new Date(image.updated_at).toISOString()!==body.updated_at)throw Error('quick_reply_changed');
   if(process.env.WECHAT_MEDIA_ENABLED!=='true'||!['shared_wechat','wechat_official_account'].includes(image.channel))throw Error('image_channel_unsupported');
   const bytes=await readStored(image.storage_key);if(bytes.length!==Number(image.size_bytes)||createHash('sha256').update(bytes).digest('hex')!==image.sha256)throw Error('image_unavailable');
   if(!(await scanWithClamAv(bytes)).clean)throw Error('image_unsafe');await member(auth);
   const transferId=quickReplyTransferId(auth.tenant_id,body.conversation_id,key,image.asset_id,body.updated_at);
   // Each conversation gets its own copy; expiring a relay never deletes library storage.
   quarantine=buildTransferStorageKey(auth.tenant_id,transferId,inspectWechatMedia('image',bytes).extension);
   const existing=(await pool.query("SELECT transfer_id FROM conversation_file_transfers WHERE tenant_id=$1 AND transfer_id=$2 AND status='ready' AND expires_at>NOW()",[auth.tenant_id,transferId])).rows[0];
   if(existing){quarantine=undefined;reply(200,{data:{transfer_id:transferId,file_name:image.file_name}});return true;}
   // A nonce avoids file-write races for two prepares with the same key.
   quarantine=buildTransferStorageKey(auth.tenant_id,`${transferId}-${randomUUID()}`,inspectWechatMedia('image',bytes).extension);
   await storeQuarantined(quarantine,bytes);clean=await prepareCleanCopy(quarantine);await removeStored(quarantine);quarantine=undefined;
   const c=await pool.connect();
   try{
    await c.query('BEGIN');
    const current=await c.query(`SELECT q.quick_reply_id FROM tenant_quick_replies q JOIN tenants t ON t.tenant_id=q.tenant_id
     JOIN tenant_memberships m ON m.tenant_id=t.tenant_id AND m.chatwoot_account_id=t.chatwoot_account_id AND m.platform_user_id=$5 AND m.status='active'
     JOIN conversation_resource_mappings r ON r.tenant_id=t.tenant_id AND r.chatwoot_account_id=t.chatwoot_account_id AND r.replynest_resource_id=$6 AND r.resource_type='conversation'
     JOIN channel_identities i ON i.tenant_id=t.tenant_id AND i.chatwoot_conversation_id::text=r.chatwoot_resource_id AND i.channel IN('shared_wechat','wechat_official_account')
     WHERE q.tenant_id=$1 AND q.quick_reply_id=$2 AND q.image_asset_id=$3 AND q.updated_at=$4::timestamptz AND q.status='active' AND t.status IN('active','test') FOR SHARE OF q,m,t,r,i`,[auth.tenant_id,prepare[1],image.asset_id,body.updated_at,auth.platform_user_id,body.conversation_id]);
    if(!current.rowCount)throw Error('quick_reply_changed');
    const saved=await c.query(`INSERT INTO conversation_file_transfers(transfer_id,tenant_id,conversation_replynest_id,direction,status,file_name,mime_type,size_bytes,storage_key,token_hash,expires_at,created_by,uploaded_at)
     VALUES($1,$2,$3,'outbound_download','ready',$4,$5,$6,$7,$8,NOW()+INTERVAL '7 days',$9,NOW()) ON CONFLICT(transfer_id) DO NOTHING RETURNING transfer_id`,[transferId,auth.tenant_id,body.conversation_id,image.file_name,image.mime_type,bytes.length,clean,createHash('sha256').update(randomUUID()).digest('hex'),auth.platform_user_id]);
    if(!saved.rowCount){const prior=await c.query("SELECT 1 FROM conversation_file_transfers WHERE transfer_id=$1 AND tenant_id=$2 AND status='ready' AND expires_at>NOW()",[transferId,auth.tenant_id]);if(!prior.rowCount)throw Error('image_unavailable');}
    await c.query('COMMIT');if(saved.rowCount)clean=undefined;
   }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
   reply(200,{data:{transfer_id:transferId,file_name:image.file_name}});return true;
  }
  reply(405,{error:{code:'method_not_allowed'}});
 }catch(error){
  const key=error instanceof Error?error.message:'';
  const known:Record<string,[number,string]>={console_session_required:[403,'仅真实登录坐席可使用图片快捷回复'],manager_required:[403,'仅企业管理员或主管可上传图片'],image_busy:[429,'图片服务繁忙，请稍后重试'],image_quota:[409,'企业快捷回复图片最多 200 张、总计 20 MiB；请移除不再使用的图片，未绑定素材会在 7 天后清理'],image_not_found:[404,'图片或快捷回复不存在'],quick_reply_changed:[409,'快捷回复已变化，请重新选择'],image_channel_unsupported:[409,'当前仅微信公众号支持图片快捷回复'],image_unsafe:[422,'图片未通过安全扫描'],image_unavailable:[409,'图片不可用，请管理员重新上传']};
  const [status,message]=known[key]??[400,'请选择不超过 2 MiB 的 JPEG、PNG 或 GIF 图片；安全处理失败时请稍后重试'];reply(status,{error:{code:key in known?key:'invalid_image',message}});
 }finally{if(clean)await removeStored(clean).catch(()=>{});if(quarantine)await removeStored(quarantine).catch(()=>{});if(slot)uploading--;}
 return true;
}

/** Orphaned uploads only; a saved active quick reply keeps its asset indefinitely. */
export async function cleanupQuickReplyImages(){
 if(!quickReplyImageEnabled())return 0;
 const retired=await pool.query(`WITH old AS(SELECT i.asset_id FROM tenant_quick_reply_images i
  WHERE i.status='ready' AND i.orphaned_at<NOW()-INTERVAL '7 days'
  AND NOT EXISTS(SELECT 1 FROM tenant_quick_replies q WHERE q.tenant_id=i.tenant_id AND q.image_asset_id=i.asset_id AND q.status='active')
  ORDER BY i.orphaned_at,i.asset_id LIMIT 20 FOR UPDATE OF i SKIP LOCKED)
  UPDATE tenant_quick_reply_images i SET status='deleted' FROM old WHERE i.asset_id=old.asset_id RETURNING i.asset_id`);
 const rows=await pool.query("SELECT asset_id,storage_key FROM tenant_quick_reply_images WHERE status='deleted' AND storage_key IS NOT NULL ORDER BY asset_id LIMIT 20");
 for(const row of rows.rows){await removeStored(row.storage_key);await pool.query("UPDATE tenant_quick_reply_images SET storage_key=NULL WHERE asset_id=$1 AND status='deleted'",[row.asset_id]);}
 return retired.rowCount??0;
}
