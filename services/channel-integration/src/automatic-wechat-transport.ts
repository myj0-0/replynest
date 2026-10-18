import {createHash} from 'node:crypto';
import type {AutomaticReceptionLease,AutomaticReceipt} from './automatic-reception-store.js';
import {AUTOMATIC_SEND_CONSENT_VERSION} from './automatic-reply-policy.js';

type Provider='wechat_official_account'|'shared_wechat';
export type AutomaticWeChatRequest=Readonly<{
 lease:AutomaticReceptionLease;appId:string;openId:string;draftText:string;
 /** Timestamp of the signature-verified USER TEXT event, not ingestion/scan/menu time. */
 sourceOccurredAt:number;merchantName?:string;
}>;
export type AutomaticWeChatAttempt=Readonly<{
 request:AutomaticWeChatRequest;content:string;contentSha256:string;
}>;
export type AutomaticWeChatClaim={outcome:'claimed';expiresAt:number}|'rejected'|'already_attempted';
export type AutomaticWeChatResult=
 |{outcome:'accepted';receipt:AutomaticReceipt}
 |{outcome:'rejected'|'uncertain';reason:AutomaticWeChatReason;providerCode?:number};
export type AutomaticWeChatReason='execution_disabled'|'invalid_target'|'invalid_content'|'source_message_stale'|
 'reply_window_expired'|'credentials_unavailable'|'authorization_changed'|'attempt_already_claimed'|
 'attempt_unconfirmed'|'provider_rate_limited'|'provider_permission_denied'|'provider_rejected'|'provider_result_uncertain';
/** Fixed internal token rejection; carries only a validated numeric code. */
export class AutomaticWeChatCredentialRejected extends Error{
 constructor(public readonly providerCode:number){
  super('automatic_wechat_credentials_rejected');
  if(!Number.isInteger(providerCode)||providerCode<=0||providerCode>2147483647)throw Error('invalid_wechat_credential_code');
  Object.freeze(this);
 }
}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v);
const numericId=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const sha=(v:string)=>createHash('sha256').update(v,'utf8').digest('hex');
const rejected=(reason:AutomaticWeChatReason):AutomaticWeChatResult=>({outcome:'rejected',reason});
const uncertain=(reason:AutomaticWeChatReason):AutomaticWeChatResult=>({outcome:'uncertain',reason});

function ageReason(occurredAt:number,now:number):AutomaticWeChatReason|null{
 if(!Number.isSafeInteger(occurredAt)||occurredAt<0||!Number.isSafeInteger(now)||occurredAt>now)return 'source_message_stale';
 if(now-occurredAt>=48*60*60*1000)return 'reply_window_expired';
 // The automatic job is much shorter-lived than the provider's text reply window.
 if(now-occurredAt>10*60*1000)return 'source_message_stale';
 return null;
}
export function copyAutomaticWeChatRequest(input:AutomaticWeChatRequest):AutomaticWeChatRequest|null{
 const l=input?.lease;
 if(!l||!uuid(l.jobId)||!uuid(l.workerToken)||!uuid(l.authorizationId)||!uuid(l.customerId)||
  typeof l.tenantId!=='string'||!l.tenantId.trim()||l.tenantId.length>200||l.tenantId.includes('\0')||
  ![l.accountId,l.conversationId,l.messageId].every(numericId)||l.consentVersion!==AUTOMATIC_SEND_CONSENT_VERSION||
  !['wechat_official_account','shared_wechat'].includes(l.channel)||
  (l.channel==='shared_wechat'?l.connectionId!==null:!uuid(l.connectionId))||
  typeof input.appId!=='string'||!/^wx[a-f0-9]{16}$/.test(input.appId)||
  typeof input.openId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(input.openId))return null;
 // Copy only known immutable fields BEFORE an await. Never keep a caller-owned lease.
 return Object.freeze({lease:Object.freeze({jobId:l.jobId,tenantId:l.tenantId,messageId:l.messageId,
  accountId:l.accountId,conversationId:l.conversationId,customerId:l.customerId,channel:l.channel,
  connectionId:l.connectionId,authorizationId:l.authorizationId,consentVersion:l.consentVersion,workerToken:l.workerToken}),
  appId:input.appId,openId:input.openId,draftText:input.draftText,sourceOccurredAt:input.sourceOccurredAt,merchantName:input.merchantName});
}
export function automaticWeChatContent(r:AutomaticWeChatRequest):string|null{
 if(typeof r.draftText!=='string'||!r.draftText.trim()||r.draftText.length>4000||r.draftText.includes('\0')||
  Buffer.from(r.draftText,'utf8').toString('utf8')!==r.draftText)return null;
 if(r.lease.channel==='wechat_official_account')return Buffer.byteLength(r.draftText,'utf8')<=1800?r.draftText:null;
 if(typeof r.merchantName!=='string'||!r.merchantName.trim()||r.merchantName.length>80||
  /[\p{Cc}\p{Cf}【】]/u.test(r.merchantName)||Buffer.from(r.merchantName,'utf8').toString('utf8')!==r.merchantName)return null;
 const content=`【${r.merchantName.trim()}】\n${r.draftText}`;
 // Match the existing shared-channel conservative byte ceiling; NEVER truncate.
 return Buffer.byteLength(content,'utf8')<=1800?content:null;
}
async function responseJson(response:Response):Promise<unknown>{
 if(!response.body)throw Error('missing_body');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 try{
  while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;
   if(length>8192)throw Error('body_limit');chunks.push(part.value);}
  const text=new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks));
  // This endpoint documents a flat two-field receipt. Decode key spellings too:
  // an escaped duplicate such as \u0065rrcode must not overwrite a rejection.
  const names=[...text.matchAll(/("(?:\\.|[^"\\])*")\s*:/g)].map(m=>JSON.parse(m[1]));
  if(names.length!==2||names.sort().join(',')!=='errcode,errmsg')throw Error('ambiguous_receipt');
  return JSON.parse(text);
 }finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
function providerResult(value:unknown,provider:Provider):AutomaticWeChatResult{
 if(!value||typeof value!=='object'||Array.isArray(value))return uncertain('provider_result_uncertain');
 const r=value as Record<string,unknown>;
 if(!Object.hasOwn(r,'errcode')||!Number.isSafeInteger(r.errcode)||Object.is(r.errcode,-0)||typeof r.errmsg!=='string')return uncertain('provider_result_uncertain');
 const code=r.errcode as number;
 if(code===0){
  if(r.errmsg!=='ok'||Object.keys(r).sort().join(',')!=='errcode,errmsg')return uncertain('provider_result_uncertain');
  // custom/send has NO message ID or delivery receipt. Do not invent one.
  return {outcome:'accepted',receipt:Object.freeze({provider,acknowledged:true})};
 }
 // Busy/system errors do not prove whether the provider accepted the request.
 if(code<0)return uncertain('provider_result_uncertain');
 const reason:AutomaticWeChatReason=code===45015?'reply_window_expired':
  [45009,45011,45047].includes(code)?'provider_rate_limited':
  [48001,48002,48004].includes(code)?'provider_permission_denied':'provider_rejected';
 return {outcome:'rejected',reason,providerCode:code};
}

/** Server-only transport primitive, NOT an ingress/worker/authorization service.
 * No env lookup, manual sender, fallback account, token refresh or retry.
 * The required claim port must recheck consent, native conversation fence, exact
 * tenant/channel/contact binding, active shared merchant and local limits, then
 * DURABLY claim this job's one transport attempt. A process-local Set is insufficient.
 * Until that port and the native external-transport barrier are integrated, this
 * module must not be registered in production. Provider ack is not user delivery.
 */
export function createAutomaticWeChatTransport(options:{
 enabled?:()=>boolean;now?:()=>number;fetcher?:typeof fetch;showAiLabel?:boolean;
 resolveAccessToken:(appId:string,channel:Provider,connectionId:string|null,signal:AbortSignal)=>Promise<{appId:string;accessToken:string}>;
 claimAuthorizedAttempt:(attempt:AutomaticWeChatAttempt)=>Promise<AutomaticWeChatClaim>;
}){
 const enabled=options.enabled??(()=>false),now=options.now??Date.now,fetcher=options.fetcher??fetch;
 if(options.showAiLabel!==undefined&&typeof options.showAiLabel!=='boolean')throw Error('invalid_ai_public_label');
 const showAiLabel=options.showAiLabel??false;
 return {send:async(input:AutomaticWeChatRequest):Promise<AutomaticWeChatResult>=>{
  if(!enabled())return rejected('execution_disabled');
  const r=copyAutomaticWeChatRequest(input);if(!r)return rejected('invalid_target');
  const content=automaticWeChatContent(r);if(content===null)return rejected('invalid_content');
  const firstAge=ageReason(r.sourceOccurredAt,now());if(firstAge)return rejected(firstAge);
  let accessToken:string;const credentialController=new AbortController();let credentialTimer:ReturnType<typeof setTimeout>|undefined;
  try{
   const deadline=new Promise<never>((_,reject)=>{credentialTimer=setTimeout(()=>{credentialController.abort();reject(Error('credential_deadline'));},8000);});
   const token=await Promise.race([options.resolveAccessToken(r.appId,r.lease.channel as Provider,r.lease.connectionId,credentialController.signal),deadline]);
   if(token.appId!==r.appId||typeof token.accessToken!=='string'||!token.accessToken||token.accessToken.length>4096||
    /\s|\p{Cc}/u.test(token.accessToken))return rejected('credentials_unavailable');
   accessToken=token.accessToken;
  }catch(error){
   if(error instanceof AutomaticWeChatCredentialRejected)return {outcome:'rejected',providerCode:error.providerCode,
    reason:[45009,45011,45047].includes(error.providerCode)?'provider_rate_limited':'credentials_unavailable'};
   return rejected('credentials_unavailable');
  }
  finally{if(credentialTimer)clearTimeout(credentialTimer);credentialController.abort();}
  if(!enabled())return rejected('execution_disabled');
  const nextAge=ageReason(r.sourceOccurredAt,now());if(nextAge)return rejected(nextAge);
  const attempt=Object.freeze({request:r,content,contentSha256:sha(content)});
  let claim:unknown;
  try{claim=await options.claimAuthorizedAttempt(attempt);}catch{return uncertain('attempt_unconfirmed');}
  if(claim==='rejected')return rejected('authorization_changed');
  if(claim==='already_attempted')return uncertain('attempt_already_claimed');
  if(!claim||typeof claim!=='object'||Array.isArray(claim))return uncertain('attempt_unconfirmed');
  const permission=claim as Record<string,unknown>;
  if(Object.keys(permission).sort().join(',')!=='expiresAt,outcome'||permission.outcome!=='claimed'||
   !Number.isSafeInteger(permission.expiresAt))return uncertain('attempt_unconfirmed');
  const expiry=permission.expiresAt as number,current=now();
  if(!Number.isSafeInteger(current)||expiry<=current||expiry-current>5000)return rejected('authorization_changed');
  // A durable marker may already exist. Do not attempt after revocation or delay,
  // and do not reopen the marker; the caller settles the terminal result.
  if(!enabled())return rejected('execution_disabled');
  const finalAge=ageReason(r.sourceOccurredAt,now());if(finalAge)return rejected(finalAge);
  if(expiry<=now())return rejected('authorization_changed');
  const url=new URL('https://api.weixin.qq.com/cgi-bin/message/custom/send');url.searchParams.set('access_token',accessToken);
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('deadline'));},8000);});
   const operation=(async()=>{
    const response=await fetcher(url,{method:'POST',redirect:'error',signal:controller.signal,
     headers:{'content-type':'application/json',accept:'application/json'},
     body:JSON.stringify({touser:r.openId,msgtype:'text',text:{content},aimsgcontext:{is_ai_msg:showAiLabel?1:0}})});
    // HTML proxy failures / HTTP rejection are not proof of provider non-acceptance.
    if(response.status!==200){void response.body?.cancel().catch(()=>{});return uncertain('provider_result_uncertain');}
    return providerResult(await responseJson(response),r.lease.channel as Provider);
   })();
   return await Promise.race([operation,timeout]);
  }catch{return uncertain('provider_result_uncertain');}
  finally{if(timer)clearTimeout(timer);controller.abort();}
 }};
}
