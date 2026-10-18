import {accessToken,type WeChatConfig} from './wechat-official.js';
import {WeChatSendRejected} from './wechat-send-error.js';
import type {WeChatMedia} from './wechat-media-core.js';
export type MediaFile={bytes:Buffer;fileName:string;mimeType:string;extension:string};
type Dependencies={fetcher?:typeof fetch;token?:(config:WeChatConfig)=>Promise<string>};
export type MediaSendStage='prepare'|'file'|'scan'|'conversation'|'binding'|'history'|'authorization'|'token'|'upload'|'send'|'record';
export class WechatMediaSendFailure extends Error {
  constructor(public readonly stage:'token'|'upload'|'send',public readonly reason:'token_unavailable'|'transport_failed'|'http_rejected'|'response_invalid'|'provider_rejected',
    public readonly httpStatus?:number,public readonly providerCode?:number){super(`wechat_media_${stage}_${reason}`);}
}
/** Never serialize an arbitrary Error, provider body, URL, token or recipient. */
export function mediaSendDiagnostic(error:unknown,stage:MediaSendStage){
  if(error instanceof WechatMediaSendFailure)return {stage:error.stage,reason:error.reason,
    ...(Number.isInteger(error.httpStatus)&&error.httpStatus!>=100&&error.httpStatus!<=599?{http_status:error.httpStatus}:{}),
    ...(Number.isInteger(error.providerCode)&&Math.abs(error.providerCode!)<=1000000?{provider_code:error.providerCode}:{})};
  if(error instanceof WeChatSendRejected)return {stage:'send' as const,reason:'provider_rejected',provider_code:error.providerCode};
  const allowed=new Set(['media_file_unavailable','media_file_unsupported','media_size_limit','media_file_unsafe','media_conversation_unavailable',
    'media_inbox_unavailable','media_send_disabled','media_history_mismatch','media_retention_invalid','media_membership_changed','media_connection_changed',
    'wechat_media_disabled','wechat_media_send_disabled','wechat_media_recipient','wechat_media_size','wechat_media_format','wechat_image_size']);
  return {stage,reason:error instanceof Error&&allowed.has(error.message)?error.message:'stage_failed'};
}
export function mediaSendFailureOutcome(error:unknown,providerStarted:boolean){
  const rejected=error instanceof WeChatSendRejected;
  const knownPreparation=error instanceof WechatMediaSendFailure&&error.stage!=='send'||error instanceof Error&&
    ['wechat_media_disabled','wechat_media_send_disabled','wechat_media_recipient','wechat_media_size','wechat_media_format','wechat_image_size'].includes(error.message);
  const uncertain=providerStarted&&!rejected&&!knownPreparation;
  return {uncertain,code:uncertain?'send_outcome_uncertain':rejected?'wechat_media_rejected':'media_not_sent'};
}
export function mediaSendFailureMessage(code:string,diagnostic:ReturnType<typeof mediaSendDiagnostic>):string{
  const stage={prepare:'发送准备',file:'文件读取/校验',scan:'安全扫描',conversation:'会话检查',binding:'渠道绑定',history:'记录准备',authorization:'权限复核',token:'微信凭据获取',upload:'微信素材上传',send:'微信发送',record:'受理结果记录'}[diagnostic.stage];
  const reasons:Record<string,string>={token_unavailable:'凭据暂不可用',transport_failed:'请求超时或网络异常',http_rejected:'接口 HTTP 异常',response_invalid:'接口响应无效',provider_rejected:'微信接口拒绝',stage_failed:'该阶段未完成',media_file_unavailable:'文件不可用或已过期',media_file_unsupported:'文件类型不支持',media_size_limit:'文件大小超限',media_file_unsafe:'文件未通过安全扫描',media_conversation_unavailable:'会话不可回复',media_inbox_unavailable:'会话渠道不支持',media_send_disabled:'渠道发送未开启',media_history_mismatch:'会话记录校验失败',media_retention_invalid:'媒体留存配置无效',media_membership_changed:'成员权限已变更',media_connection_changed:'渠道绑定已变更',wechat_media_disabled:'媒体功能未开启',wechat_media_send_disabled:'渠道发送未开启',wechat_media_recipient:'收件身份无效',wechat_media_size:'文件大小超限',wechat_media_format:'文件格式不支持',wechat_image_size:'图片大小超限'};
  const details=[reasons[diagnostic.reason]??'该阶段未完成','http_status' in diagnostic?`HTTP ${diagnostic.http_status}`:'','provider_code' in diagnostic?`微信错误码 ${diagnostic.provider_code}`:''].filter(Boolean).join(' · ');
  return `${code==='send_outcome_uncertain'?'媒体发送结果尚未确认，请勿重发；请联系管理员核查':code==='wechat_media_rejected'?'微信明确拒绝本次媒体发送':'媒体未发送'}。${stage}：${details}`;
}
const maximum=10*1024*1024;
export function inspectWechatMedia(kind:WeChatMedia['kind'],bytes:Buffer):Omit<MediaFile,'bytes'> {
  if(!bytes.length||bytes.length>maximum)throw Error('wechat_media_size');
  let mimeType='',extension='';
  if(kind==='image'){
    if(bytes[0]===255&&bytes[1]===216){mimeType='image/jpeg';extension='.jpg';}
    else if(bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'){mimeType='image/png';extension='.png';}
    else if(['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString())){mimeType='image/gif';extension='.gif';}
  }else if(kind==='video'&&bytes.length>=12&&bytes.subarray(4,8).toString()==='ftyp'){
    const length=bytes.readUInt32BE(0);
    if(length>=16&&length<=bytes.length&&['isom','iso2','mp41','mp42','avc1','M4V ','qt  '].includes(bytes.subarray(8,12).toString())){mimeType='video/mp4';extension='.mp4';}
  }else if(kind==='voice'){
    if(bytes.subarray(0,6).toString()==='#!AMR\n'||bytes.subarray(0,9).toString()==='#!AMR-WB\n'){mimeType='audio/amr';extension='.amr';}
    else if(bytes.subarray(0,4).toString()==='OggS'&&bytes.subarray(0,256).includes(Buffer.from('Speex   '))){mimeType='audio/speex';extension='.ogg';}
    else if(bytes.subarray(0,3).toString()==='ID3'||bytes[0]===255&&(bytes[1]&0xe0)===0xe0){mimeType='audio/mpeg';extension='.mp3';}
  }
  if(!extension)throw Error('wechat_media_format');
  return {fileName:`微信${{image:'图片',video:'视频',voice:'语音'}[kind]}${extension}`,mimeType,extension};
}
async function bounded(response:Response,limit=maximum):Promise<Buffer>{
  if(!response.ok||!response.body)throw Error('wechat_media_unavailable');
  if(Number(response.headers.get('content-length'))>limit){await response.body.cancel();throw Error('wechat_media_size');}
  const reader=response.body.getReader(),chunks:Buffer[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('wechat_media_size');chunks.push(Buffer.from(value));}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  return Buffer.concat(chunks,size);
}
/** Only the verified account's fixed provider endpoint. Callback PicUrl is never fetched. */
export async function downloadOfficialMedia(config:WeChatConfig,media:WeChatMedia,deps:Dependencies={}):Promise<MediaFile>{
  if(!config.appId||!config.appSecret||!/^[A-Za-z0-9_-]{1,512}$/.test(media.mediaId))throw Error('wechat_media_binding');
  const fetcher=deps.fetcher??fetch;let token:string;
  try{token=await (deps.token??accessToken)(config);}catch{throw Error('wechat_media_token_unavailable');}
  const url=new URL('https://api.weixin.qq.com/cgi-bin/media/get');url.searchParams.set('access_token',token);url.searchParams.set('media_id',media.mediaId);
  let bytes=await bounded(await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(15000)}));
  if(bytes[0]===123){
    let data:any;try{data=JSON.parse(bytes.toString());}catch{throw Error('wechat_media_invalid_response');}
    if(media.kind!=='video'||typeof data.video_url!=='string')throw Error('wechat_media_provider_rejected');
    let target:URL;try{target=new URL(data.video_url);}catch{throw Error('wechat_media_url_rejected');}
    // Provider sometimes returns an HTTP URL; never send credentials or allow an arbitrary host/redirect.
    if(!['https:','http:'].includes(target.protocol)||target.hostname!=='video.weixin.qq.com'||target.port||target.username||target.password||target.hash)throw Error('wechat_media_url_rejected');
    target.protocol='https:';
    bytes=await bounded(await fetcher(target,{redirect:'error',signal:AbortSignal.timeout(15000)}));
  }
  return {bytes,...inspectWechatMedia(media.kind,bytes)};
}
/** Caller must commit its idempotent command before this external side effect. Never retries a send. */
export async function sendOfficialMedia(config:WeChatConfig,userId:string,kind:'image'|'video',file:MediaFile,
  options:{shared:boolean;merchantName?:string},deps:Dependencies={}):Promise<void>{
  if(process.env.WECHAT_MEDIA_ENABLED!=='true')throw Error('wechat_media_disabled');
  if(options.shared?(process.env.SHARED_WECHAT_MANUAL_SEND_ENABLED!=='true'||config.appId!==process.env.SHARED_WECHAT_APP_ID):
    (process.env.WECHAT_LIVE_ENABLED!=='true'||config.appId===process.env.SHARED_WECHAT_APP_ID))throw Error('wechat_media_send_disabled');
  if(!/^[A-Za-z0-9_-]{1,200}$/.test(userId))throw Error('wechat_media_recipient');
  inspectWechatMedia(kind,file.bytes);
  // Conservative upload limits. Invalid files must fail before either provider request.
  if(kind==='image'&&file.bytes.length>2*1024*1024)throw Error('wechat_image_size');
  const fetcher=deps.fetcher??fetch;let token:string;
  try{token=await (deps.token??accessToken)(config);}catch{throw new WechatMediaSendFailure('token','token_unavailable');}
  const form=new FormData();form.set('media',new Blob([new Uint8Array(file.bytes)],{type:file.mimeType}),`media${file.extension}`);
  let uploaded:Response;
  try{uploaded=await fetcher(`https://api.weixin.qq.com/cgi-bin/media/upload?access_token=${encodeURIComponent(token)}&type=${kind}`,{
    method:'POST',body:form,redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new WechatMediaSendFailure('upload','transport_failed');}
  if(!uploaded.ok){await uploaded.body?.cancel().catch(()=>{});throw new WechatMediaSendFailure('upload','http_rejected',uploaded.status);}
  let body:any;
  try{body=JSON.parse((await bounded(uploaded,16384)).toString());}catch{throw new WechatMediaSendFailure('upload','response_invalid',uploaded.status);}
  if(!body||typeof body!=='object'||Array.isArray(body))throw new WechatMediaSendFailure('upload','response_invalid',uploaded.status);
  if(body.errcode!=null&&body.errcode!==0)throw new WechatMediaSendFailure('upload','provider_rejected',uploaded.status,body.errcode);
  if(typeof body.media_id!=='string'||!/^[A-Za-z0-9_-]{1,512}$/.test(body.media_id))throw new WechatMediaSendFailure('upload','response_invalid',uploaded.status);
  const caption=String(options.merchantName??'').replace(/[\r\n\u0000-\u001f]/g,' ').slice(0,80);
  const payload={touser:userId,msgtype:kind,[kind]:{media_id:body.media_id,...(kind==='video'&&caption?{title:caption,description:`来自${caption}的客服视频`}:{})}};
  let sent:Response;
  try{sent=await fetcher(`https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(10000)});}catch{throw new WechatMediaSendFailure('send','transport_failed');}
  if(!sent.ok){await sent.body?.cancel().catch(()=>{});throw new WechatMediaSendFailure('send','http_rejected',sent.status);}
  let result:any;try{result=JSON.parse((await bounded(sent,16384)).toString());}catch{throw new WechatMediaSendFailure('send','response_invalid',sent.status);}
  if(!result||typeof result!=='object'||Array.isArray(result)||result.errcode!==0){if(Number.isInteger(result?.errcode)&&result.errcode>0&&result.errcode<=1000000)throw new WeChatSendRejected(result.errcode);throw new WechatMediaSendFailure('send','response_invalid',sent.status);}
}
