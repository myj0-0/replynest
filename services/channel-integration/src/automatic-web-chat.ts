import type {Pool,PoolClient} from 'pg';
import {AUTOMATIC_SEND_CONSENT_VERSION,type AutomaticReplyFacts} from './automatic-reply-policy.js';
import {automaticModeGuard} from './automatic-reception-mode.js';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import type {ReceptionDraft} from './reception-executor.js';
import type {AutomaticSubmission} from './automatic-reception-runtime.js';
import {withStoredAutomaticAssessment} from './automatic-reception-grounded-adapter.js';
import {createAutomaticNativeClient,type AutomaticNativeSnapshot} from './automatic-web-native-client.js';
import {readPublicAiLabel} from './ai-public-label.js';

type Db=Pick<PoolClient,'query'>;
export type AutomaticWebTarget=Readonly<{tenantId:string;accountId:string;conversationId:string;connectionId:string;customerId:string;
 inboxId:string;contactId:string;authorizationAt:string}>;
export type AutomaticWebSnapshot={current:boolean;human:boolean;replyable:boolean;question:string|null};
type RecordValue=Record<string,unknown>;
const record=(v:unknown):RecordValue|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as RecordValue:null;
function id(v:unknown):string|null{
 if(typeof v==='number'&&!Number.isSafeInteger(v))return null;
 return typeof v==='string'||typeof v==='number'?(/^[1-9]\d{0,19}$/.test(String(v))?String(v):null):null;
}
/** Only the lease's tenant-local website binding. No global/default account, model target or fallback. */
export async function loadAutomaticWebTarget(db:Db,l:AutomaticReceptionLease,lock=false):Promise<AutomaticWebTarget|null>{
 if(l.channel!=='web_chat'||!l.connectionId||!id(l.accountId)||!id(l.conversationId)||!id(l.messageId))return null;
 const result=await db.query(`SELECT c.configuration->>'chatwoot_inbox_id' inbox_id,i.chatwoot_contact_id::text contact_id,g.updated_at authorization_at
 FROM channel_identities i JOIN channel_connections c ON c.connection_id=i.channel_connection_id AND c.tenant_id=i.tenant_id
 JOIN tenants t ON t.tenant_id=i.tenant_id JOIN automatic_reception_grants g ON g.tenant_id=t.tenant_id
 JOIN tenant_ai_settings s ON s.tenant_id=t.tenant_id
 WHERE i.tenant_id=$1 AND i.customer_id=$2 AND i.channel='web_chat' AND i.channel_connection_id=$3
  AND i.chatwoot_conversation_id::text=$4 AND c.channel_type='web_chat' AND c.status='ready'
  AND t.status IN('active','test') AND t.chatwoot_account_id::text=$5 AND c.configuration->>'chatwoot_account_id'=$5
  AND g.account_id=$5 AND g.authorization_id=$6 AND g.consent_version=$7 AND g.enabled
  AND ${automaticModeGuard}
 ORDER BY i.identity_id LIMIT 2 ${lock?'FOR SHARE OF i,c,t,g,s':''}`,
 [l.tenantId,l.customerId,l.connectionId,l.conversationId,l.accountId,l.authorizationId,AUTOMATIC_SEND_CONSENT_VERSION]);
 if(result.rows.length!==1)return null;
 const r=result.rows[0],inboxId=id(r.inbox_id),contactId=id(r.contact_id),authorizationAt=new Date(r.authorization_at).toISOString();
 if(!inboxId||!contactId)return null;
 return Object.freeze({tenantId:l.tenantId,accountId:l.accountId,conversationId:l.conversationId,connectionId:l.connectionId,
  customerId:l.customerId,inboxId,contactId,authorizationAt});
}
/** Historical public-API diagnostic only; NEVER used by the automatic-send adapter.
 * A bounded latest-page read is conservative: if the target is absent we never page through history.
 * Any newer public outgoing message is treated as a reply. Assignment alone is routing, not pause.
 */
export function automaticWebSnapshot(target:AutomaticWebTarget,messageId:string,conversation:unknown,inbox:unknown,messages:unknown,now:Date):AutomaticWebSnapshot{
 const denied:AutomaticWebSnapshot={current:false,human:true,replyable:false,question:null};
 const c=record(conversation),i=record(inbox),m=record(messages),meta=record(c?.meta),sender=record(meta?.sender),attributes=record(c?.custom_attributes);
 if(!c||!i||!meta||!sender||!m||!id(messageId)||!Number.isFinite(now.getTime())||
  id(c.id)!==target.conversationId||id(c.account_id)!==target.accountId||id(c.inbox_id)!==target.inboxId||id(sender.id)!==target.contactId||
  id(i.id)!==target.inboxId||id(i.account_id)!==target.accountId||i.channel_type!=='Channel::WebWidget'||
  !['open','pending'].includes(String(c.status))||c.can_reply!==true||
  attributes?.source_channel==='shared_wechat'||attributes?.replynest_shared_contact!==undefined||
  !Array.isArray(m.payload)||!m.payload.length||m.payload.length>20)return denied;
 const publicMessages:RecordValue[]=[];const seen=new Set<string>();
 for(const raw of m.payload){
  const msg=record(raw),key=id(msg?.id);
  if(!msg||!key||seen.has(key)||typeof msg.private!=='boolean'||id(msg.conversation_id)!==target.conversationId||
   (msg.account_id!==undefined&&id(msg.account_id)!==target.accountId))return denied;
  seen.add(key);
  if(msg.private)continue;
  if([0,1,'incoming','outgoing'].includes(msg.message_type as string|number))publicMessages.push(msg);
  else if(![2,'activity'].includes(msg.message_type as string|number))return denied;
 }
 publicMessages.sort((a,b)=>BigInt(String(a.id))>BigInt(String(b.id))?-1:1);
 const latest=publicMessages[0],job=publicMessages.find(msg=>id(msg.id)===messageId),contact=record(job?.sender);
 if(!job||![0,'incoming'].includes(job.message_type as string|number)||job.content_type!=='text'||id(contact?.id)!==target.contactId||
  contact?.type!=='contact')return denied;
 const at=typeof job.created_at==='number'?job.created_at*1000:Date.parse(String(job.created_at)),authorized=Date.parse(target.authorizationAt);
 if(!Number.isFinite(at)||!Number.isFinite(authorized)||at<authorized||at>now.getTime()+30_000||now.getTime()-at>600_000||
  typeof job.content!=='string'||!job.content.trim()||job.content.length>4000)return denied;
 const human=publicMessages.some(msg=>[1,'outgoing'].includes(msg.message_type as string|number)&&BigInt(String(msg.id))>BigInt(messageId));
 return {current:id(latest?.id)===messageId,human,replyable:!human,question:job.content.trim()};
}
export type AutomaticWebPolicy=Pick<AutomaticReplyFacts,'executorAvailable'|'consentVersion'|'sendConsentVersion'|'generateEnabled'|'sendEnabled'|'pointsAvailable'|'thresholdPercent'|'requiresHumanApproval'>;
/** Server-only factory. Explicit execution gate; no factory-owned timer or implicit credentials.
 * Native conditional submission closes the engine read/POST gap, not a distributed
 * transaction with gateway consent, knowledge and points. No public-message POST fallback.
 */
export function createAutomaticWebChatAdapter(db:Pick<Pool,'query'|'connect'>,options:{origin:string;secret:string;enabled?:()=>boolean;
 fetcher?:typeof fetch;now?:()=>Date;policy:(db:Db,l:AutomaticReceptionLease)=>Promise<AutomaticWebPolicy>;
 generate:(l:AutomaticReceptionLease,question:string)=>Promise<ReceptionDraft>}){
 const native=createAutomaticNativeClient(options),enabled=options.enabled??(()=>false);
 const verified=new WeakMap<AutomaticReceptionLease,{target:AutomaticWebTarget;snapshot:AutomaticNativeSnapshot}>();
 async function facts(client:Db,l:AutomaticReceptionLease,lock=false):Promise<AutomaticReplyFacts>{
  const p=await options.policy(client,l),target=enabled()?await loadAutomaticWebTarget(client,l,lock):null;
  // Native HTTP never holds business SQL locks. Final authorization uses the
  // freshly captured fence; native conditional submit rejects any later change.
  if(!lock){const snapshot:AutomaticNativeSnapshot=target?await native.snapshot(target,l.messageId):{current:false,human:true,replyable:false,question:null,fence:null};
   if(target)verified.set(l,{target,snapshot:structuredClone(snapshot)});else verified.delete(l);}
  const saved=verified.get(l),same=!!target&&!!saved&&JSON.stringify(target)===JSON.stringify(saved.target);
  const snapshot:AutomaticNativeSnapshot=same?saved.snapshot:{current:false,human:true,replyable:false,question:null,fence:null};
  return {...p,executorAvailable:enabled()&&p.executorAvailable,tenantActive:!!target,latestCustomerMessage:snapshot.current,humanResponded:snapshot.human,
   channelReplyable:snapshot.replyable,generated:false,fallback:false,evidenceCandidate:false,confidencePercent:0};
 }
 return withStoredAutomaticAssessment(db,{
  enabled,facts:l=>facts(db,l),authorizeFacts:(client,l)=>facts(client,l,true),
  canonicalQuestion:async l=>{const s=verified.get(l)?.snapshot;return enabled()&&s?.current&&!s.human&&s.replyable&&s.fence?s.question:null;},
  question:async(_client,l)=>verified.get(l)?.snapshot.question??'',
  generate:async l=>{const s=verified.get(l)?.snapshot;if(!enabled()||!s?.current||s.human||!s.question)throw Error('automatic_question_unavailable');return options.generate(l,s.question);},
  submit:async(l,d):Promise<AutomaticSubmission>=>{
   if(!enabled()||l.channel!=='web_chat')return {outcome:'rejected'};
   const v=verified.get(l);if(!v||!v.snapshot.current||v.snapshot.human||!v.snapshot.fence)return {outcome:'rejected'};
   const barrier=await db.query(`SELECT 1 FROM automatic_reception_jobs WHERE tenant_id=$1 AND job_id=$2 AND message_id=$3 AND worker_token=$4
    AND state='submitting' AND account_id=$5 AND conversation_id=$6 AND customer_id=$7 AND connection_id=$8 AND channel='web_chat' AND draft->>'text'=$9`,
    [l.tenantId,l.jobId,l.messageId,l.workerToken,l.accountId,l.conversationId,l.customerId,l.connectionId,d.text]);
   if(barrier.rowCount!==1)return {outcome:'rejected'};
   const current=await loadAutomaticWebTarget(db,l);
   if(!current||JSON.stringify(current)!==JSON.stringify(v.target))return {outcome:'rejected'};
   // Retain the FINAL authorization fence. A newer read here would bless changes
   // after the gateway submit barrier; the native transaction must reject them.
   if(!enabled())return {outcome:'rejected'};
   // Durable one-attempt claim, including direct adapter reuse or a restarted factory.
   // If a crash occurs after this marker but before POST, do not retry automatically.
   const label=await readPublicAiLabel(db,l.tenantId);
   const attempt=await db.query(`UPDATE automatic_reception_jobs SET transport_attempted_at=NOW() WHERE tenant_id=$1 AND job_id=$2
    AND worker_token=$3 AND state='submitting' AND transport_attempted_at IS NULL RETURNING job_id`,[l.tenantId,l.jobId,l.workerToken]);
   if(attempt.rowCount!==1)return {outcome:'uncertain'};
   try{
    return await native.submit(v.target,l.messageId,l.jobId,d.text,v.snapshot.fence,label.effective);
   }catch{return {outcome:'uncertain'};}finally{verified.delete(l);}
  }
 });
}
