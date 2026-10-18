/** Provider credentials stay in verified ingress/store, never in notifications. */
export type WeChatMedia = { kind: 'image'|'video'|'voice'; mediaId: string; format?: 'amr'|'speex'; recognition?: string };
export function officialMedia(raw: Record<string,string>): WeChatMedia|undefined {
  const kind=raw.MsgType==='shortvideo'?'video':raw.MsgType;
  if(!['image','video','voice'].includes(kind))return undefined;
  if(!/^[A-Za-z0-9_-]{1,512}$/.test(raw.MediaId??'')||!/^\d{1,40}$/.test(raw.MsgId??''))throw Error('invalid_wechat_media');
  if(kind==='voice'&&raw.Format&&!['amr','speex'].includes(raw.Format))throw Error('invalid_wechat_voice_format');
  return {kind:kind as WeChatMedia['kind'],mediaId:raw.MediaId,
    ...(kind==='voice'&&raw.Format?{format:raw.Format as 'amr'|'speex'}:{}),
    ...(kind==='voice'&&raw.Recognition?{recognition:raw.Recognition.slice(0,2000)}:{})};
}
export function mediaLabel(kind:WeChatMedia['kind']):string { return {image:'图片',video:'视频',voice:'语音'}[kind]; }
export type MessageMediaNotice={message_type:'image'|'video'|'voice'; attachment_count:number; view_path?:string;attachment_id?:string;processing_status?:'ready'|'failed'|'expired'};
/** No source URL, OpenID, MediaId, download token or transcript in public notifications. */
export function mediaNotice(input:unknown):MessageMediaNotice|undefined {
  if(!input||typeof input!=='object'||Array.isArray(input))return undefined;
  const row=input as Record<string,unknown>;
  if(typeof row.message_type!=='string'||!['image','video','voice'].includes(row.message_type))return undefined;
  if(!Number.isInteger(row.attachment_count)||Number(row.attachment_count)<1||Number(row.attachment_count)>10)return undefined;
  const path=typeof row.view_path==='string'&&/^\/workbench\?conversation=[0-9a-f-]{36}$/i.test(row.view_path)?row.view_path:undefined;
  const id=typeof row.attachment_id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.attachment_id)?row.attachment_id:undefined;
  const status=typeof row.processing_status==='string'&&['ready','failed','expired'].includes(row.processing_status)?row.processing_status as MessageMediaNotice['processing_status']:undefined;
  return {message_type:row.message_type as MessageMediaNotice['message_type'],attachment_count:Number(row.attachment_count),...(path?{view_path:path}:{}),...(id?{attachment_id:id}:{}),...(status?{processing_status:status}:{})};
}
export function mediaOnlyMessage(message:Record<string,any>):boolean {
  return Boolean(message.attachments?.length||message.content_attributes?.replynest_media_kind||/^\[公众号消息\] (图片|视频|小视频|语音)$/.test(String(message.content??'')));
}
/** The event-store boundary preserves only validated, credential-free media fields. */
export function notificationMediaMetadata(input:Record<string,unknown>|undefined):Record<string,string|number|null>{
  const notice=mediaNotice({message_type:input?.message_type,attachment_count:input?.attachment_count,
    view_path:input?.media_view_path,attachment_id:input?.media_attachment_id,processing_status:input?.media_status});
  return notice?{message_type:notice.message_type,attachment_count:notice.attachment_count,
    media_view_path:notice.view_path??null,media_attachment_id:notice.attachment_id??null,media_status:notice.processing_status??null}:{};
}
