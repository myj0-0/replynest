import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import {loadAutomaticWeChatTarget} from './automatic-wechat-target.js';
import {readWeChatCredential} from './wechat-connection.js';
import {sharedWechatConfig} from './shared-wechat-config.js';
import {AutomaticWeChatCredentialRejected} from './automatic-wechat-transport.js';
type Material={appId:string;appSecret:string};
/** Trusted server ports only. Always tenant-bound before looking up a file or
 * cache entry. Does not share the manual sender's force-refresh/error behavior.
 */
export function createAutomaticWeChatTokenResolver(db:Pick<Pool,'query'>,options:{enabled?:()=>boolean;fetcher?:typeof fetch;
 readIndependent?:(reference:string,appId:string)=>Promise<Material>;readShared?:()=>Promise<Material>;now?:()=>number}={}){
 const enabled=options.enabled??(()=>false),fetcher=options.fetcher??fetch,now=options.now??Date.now;
 const cache=new Map<string,{value:string;expiresAt:number}>();
 const failure=()=>Error('automatic_wechat_credentials_unavailable');
 async function binding(l:AutomaticReceptionLease,appId:string){
  const job=await db.query(`SELECT 1 FROM automatic_reception_jobs WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3
   AND state='submitting' AND channel=$4 AND account_id=$5 AND conversation_id=$6 AND customer_id=$7 AND message_id=$8
   AND connection_id IS NOT DISTINCT FROM $9::uuid AND authorization_id=$10 AND consent_version=$11`,
   [l.tenantId,l.jobId,l.workerToken,l.channel,l.accountId,l.conversationId,l.customerId,l.messageId,l.connectionId,l.authorizationId,l.consentVersion]);
  if(job.rowCount!==1)throw failure();
  const target=await loadAutomaticWeChatTarget(db,l);
  if(!target||target.appId!==appId||target.sourceOccurredAt>now()||now()-target.sourceOccurredAt>600000)throw failure();
  if(l.channel==='shared_wechat')return {target,reference:null};
  const rows=(await db.query(`SELECT credential_ref FROM channel_connections WHERE tenant_id=$1 AND connection_id=$2
   AND external_account_id=$3 AND channel_type='wechat_official_account' AND status='ready'
   AND configuration->>'chatwoot_account_id'=$4 AND configuration->>'chatwoot_inbox_id'=$5
   AND NOT EXISTS(SELECT 1 FROM shared_wechat_accounts WHERE app_id=$3 AND enabled) LIMIT 2`,
   [l.tenantId,l.connectionId,appId,l.accountId,target.native.inboxId])).rows;
  if(rows.length!==1||typeof rows[0].credential_ref!=='string'||!rows[0].credential_ref)throw failure();
  return {target,reference:rows[0].credential_ref as string};
 }
 async function material(reference:string|null,appId:string){
  const m=reference===null?await(options.readShared??sharedWechatConfig)():await(options.readIndependent??readWeChatCredential)(reference,appId);
  if(!m||m.appId!==appId||typeof m.appSecret!=='string'||!/^[a-fA-F0-9]{32}$/.test(m.appSecret))throw failure();
  return Object.freeze({appId:m.appId,appSecret:m.appSecret});
 }
 async function token(m:Material,signal:AbortSignal){
  const start=now(),key=createHash('sha256').update(JSON.stringify([m.appId,m.appSecret])).digest('hex');
  const prior=cache.get(key);if(prior&&prior.expiresAt>start+15000)return prior.value;
  const r=await fetcher('https://api.weixin.qq.com/cgi-bin/stable_token',{method:'POST',redirect:'error',signal,
   headers:{'content-type':'application/json',accept:'application/json'},
   body:JSON.stringify({grant_type:'client_credential',appid:m.appId,secret:m.appSecret,force_refresh:false})});
  if(signal.aborted||!enabled()){void r.body?.cancel().catch(()=>{});throw failure();}
  if(r.status!==200){void r.body?.cancel().catch(()=>{});throw failure();}
  if(!r.body)throw failure();const reader=r.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  let value:unknown;
  try{
   while(true){if(signal.aborted)throw failure();const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>8192)throw failure();chunks.push(part.value);}
   const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
   const names=[...text.matchAll(/("(?:\\.|[^"\\])*")\s*:/g)].map(match=>JSON.parse(match[1]));
   if(!['access_token,expires_in','errcode,errmsg'].includes(names.sort().join(',')))throw failure();
   value=JSON.parse(text);
  }finally{signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});reader.releaseLock();}
  const body=value as Record<string,unknown>;
  if(body&&Object.keys(body).sort().join(',')==='errcode,errmsg'&&typeof body.errmsg==='string'&&
   Number.isInteger(body.errcode)&&Number(body.errcode)>0&&Number(body.errcode)<=2147483647)throw new AutomaticWeChatCredentialRejected(Number(body.errcode));
  if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='access_token,expires_in'||
   typeof body.access_token!=='string'||!body.access_token||body.access_token.length>4096||/\s|\p{Cc}/u.test(body.access_token)||
   !Number.isInteger(body.expires_in)||Number(body.expires_in)<=30||Number(body.expires_in)>7200)throw failure();
  const expiresAt=start+Number(body.expires_in)*1000-30000;
  if(signal.aborted||!enabled()||expiresAt<=now()+15000)throw failure();
  for(const [k,v] of cache)if(v.expiresAt<=now()+15000)cache.delete(k);
  if(cache.size>=128)cache.delete(cache.keys().next().value!);
  cache.set(key,{value:body.access_token,expiresAt});return body.access_token;
 }
 return async(l:AutomaticReceptionLease,appId:string,signal:AbortSignal):Promise<{appId:string;accessToken:string}>=>{
  if(!enabled()||signal.aborted||!/^wx[a-f0-9]{16}$/.test(appId))throw failure();
  const lease=Object.freeze({...l}),controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
  let timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined;
  const check=()=>{if(combined.aborted||!enabled())throw failure();};
  const deadline=new Promise<never>((_resolve,reject)=>{
   abort=()=>reject(failure());combined.addEventListener('abort',abort,{once:true});
   timer=setTimeout(()=>controller.abort(),7000);
  });
  try{
   const operation=(async()=>{
    const before=await binding(lease,appId);check();const m=await material(before.reference,appId);check();
    const accessToken=await token(m,combined);check();
    const after=await binding(lease,appId);check();
    if(JSON.stringify(after)!==JSON.stringify(before))throw failure();
    const current=await material(after.reference,appId);check();
    if(current.appSecret!==m.appSecret)throw failure();
    return Object.freeze({appId,accessToken});
   })();
   return await Promise.race([operation,deadline]);
  }catch(error){if(error instanceof AutomaticWeChatCredentialRejected)throw error;throw failure();}
  finally{if(timer)clearTimeout(timer);if(abort)combined.removeEventListener('abort',abort);controller.abort();}
 };
}
