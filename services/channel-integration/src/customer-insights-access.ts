import {createHash,createHmac,randomBytes} from 'node:crypto';
import type {Pool} from 'pg';
import type {InsightsActor,VerifiedInsightEvent} from './customer-insights-store.js';
import {parseUniqueReceptionJson} from './reception-history-native-client.js';
const path='/internal/saas_sso/customer_insights_history/permission';
export type InsightPermissionInput={account_id:string;conversation_id:string;contact_id:string;native_actor_id:string;native_actor_email:string;purpose:'customerInsights'};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
function validate(v:InsightPermissionInput){
 if(!v||Object.keys(v).sort().join(',')!=='account_id,contact_id,conversation_id,native_actor_email,native_actor_id,purpose'||
  ![v.account_id,v.conversation_id,v.contact_id,v.native_actor_id].every(id)||v.purpose!=='customerInsights'||
  typeof v.native_actor_email!=='string'||Buffer.byteLength(v.native_actor_email)>320||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.native_actor_email)||
  v.native_actor_email!==v.native_actor_email.toLowerCase())throw Error('insights_identity_required');
}
export function createInsightPermissionClient(options:{origin:string;secret:string;fetcher?:typeof fetch}){
 const origin=new URL(options.origin);
 if(!['http:','https:'].includes(origin.protocol)||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password||
  Buffer.byteLength(options.secret)<32||Buffer.byteLength(options.secret)>65536||/[\0\r\n]/.test(options.secret))throw Error('insights_permission_unavailable');
 return async(input:InsightPermissionInput)=>{
  validate(input);const body=JSON.stringify(input),stamp=String(Date.now()),nonce=randomBytes(16).toString('hex'),controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('insights_permission_unavailable'));},2000);});
  try{return await Promise.race([(async()=>{
   const r=await(options.fetcher??fetch)(origin.origin+path,{method:'POST',redirect:'error',signal:controller.signal,
    headers:{'content-type':'application/json','x-forwarded-proto':'https','x-automatic-timestamp':stamp,'x-automatic-nonce':nonce,
     'x-automatic-signature':createHmac('sha256',options.secret).update(`${path}\n${stamp}\n${nonce}\n${body}`).digest('hex')},body});
   if(!r.ok||!r.body)throw Error('insights_permission_unavailable');
   const reader=r.body.getReader(),chunks:Uint8Array[]=[];let size=0;
   const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
   try{for(;;){if(controller.signal.aborted)throw Error('insights_permission_unavailable');const v=await reader.read();if(v.done)break;size+=v.value.length;if(size>4096)throw Error('insights_permission_unavailable');chunks.push(v.value);}}
   finally{controller.signal.removeEventListener('abort',cancel);cancel();reader.releaseLock();}
   const v=parseUniqueReceptionJson(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks))) as any;
   if(!v||Object.keys(v).sort().join(',')!=='account_id,assigned,contact_id,conversation_id,native_actor_id,request_sha256'||
    ['account_id','conversation_id','contact_id','native_actor_id'].some(k=>v[k]!==input[k as keyof InsightPermissionInput])||typeof v.assigned!=='boolean'||
    v.request_sha256!==createHash('sha256').update(body).digest('hex'))throw Error('insights_permission_unavailable');
   return {assigned:v.assigned as boolean};
  })(),deadline]);}finally{clearTimeout(timer);controller.abort();}
 };
}
/** Server-owned lookup, never browser-supplied native IDs or email. No caching:
 * current product seat and native assignment checked for every edit. */
export function createInsightAccessPort(db:Pick<Pool,'query'>,options:Parameters<typeof createInsightPermissionClient>[0]){
 const read=createInsightPermissionClient(options);
 return async(a:InsightsActor,e:Omit<VerifiedInsightEvent,'messageId'>)=>{
  if(a.impersonated||a.tenantId!==e.tenantId||a.accountId!==e.accountId)throw Error('insights_identity_required');
  const rows=(await db.query(`SELECT DISTINCT m.chatwoot_user_id::text native_actor_id,lower(m.chatwoot_user_email) native_actor_email,i.chatwoot_contact_id::text contact_id
   FROM tenants t JOIN tenant_memberships m USING(tenant_id) JOIN platform_users u USING(platform_user_id)
   JOIN channel_identities i ON i.tenant_id=t.tenant_id JOIN customers cu ON cu.tenant_id=i.tenant_id AND cu.customer_id=i.customer_id
   WHERE t.tenant_id=$1 AND t.chatwoot_account_id=$2 AND t.status IN('active','test') AND m.platform_user_id=$3
    AND m.chatwoot_account_id=$2 AND m.role=$4 AND m.status='active' AND m.chatwoot_sync_status='synced' AND u.status='active'
    AND i.customer_id=$5 AND i.chatwoot_conversation_id=$6 AND i.sync_status='synced' AND i.chatwoot_contact_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM channel_identities other WHERE other.tenant_id=i.tenant_id AND other.chatwoot_contact_id=i.chatwoot_contact_id
      AND other.customer_id IS DISTINCT FROM i.customer_id) LIMIT 2`,[a.tenantId,a.accountId,a.userId,a.role,e.customerId,e.conversationId])).rows;
  if(rows.length!==1)throw Error('insights_customer_unavailable');
  const native=rows[0];return read({account_id:a.accountId,conversation_id:e.conversationId,contact_id:native.contact_id,
   native_actor_id:native.native_actor_id,native_actor_email:native.native_actor_email,purpose:'customerInsights'});
 };
}
