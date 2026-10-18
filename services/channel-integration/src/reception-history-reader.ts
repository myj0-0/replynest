import type {Pool,PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {currentReceptionHistoryGrant} from './reception-personalization.js';
import {selectReceptionHistorySample,suggestReceptionStyle,RECEPTION_HISTORY_DISCLOSURES,type ReceptionHistoryMessage,type ReceptionHistoryPurpose,type ReceptionHistoryScope,type ReceptionLearnedStyle} from './reception-history-learning.js';
import type {NativeHistoryRequest,NativeHistoryPage,HistoryCursor} from './reception-history-native-client.js';
export type AuthorizedHistoryScope=Readonly<{tenantId:string;accountId:string;purpose:ReceptionHistoryPurpose;grantId:string;customerId?:string}>;
type Db=Pick<Pool,'connect'>;
type Port={page(request:NativeHistoryRequest):Promise<{outcome:'ready';page:NativeHistoryPage}|{outcome:'rejected'|'unavailable'}>};
export type AuthorizedHistorySample={purpose:'style';style:ReceptionLearnedStyle;sampleDigest:string;scanned:number;pages:number;asOf:string}|
 {purpose:'context'|'knowledgeDraft';messages:readonly ReceptionHistoryMessage[];sampleDigest:string;scanned:number;pages:number;asOf:string;privacyPolicy:'history-redaction-v1'};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const digest=(rows:readonly ReceptionHistoryMessage[])=>createHash('sha256').update(JSON.stringify(rows.map(r=>({id:r.messageId,at:r.createdAtMs,hash:createHash('sha256').update(r.text).digest('hex')})))).digest('hex');
function validate(scope:AuthorizedHistoryScope){
 if(!scope||Object.keys(scope).sort().join(',')!==(['accountId','grantId','purpose','tenantId',...(scope.customerId===undefined?[]:['customerId'])].sort().join(','))||
  !/^[a-zA-Z0-9_-]{1,200}$/.test(scope.tenantId)||!/^[1-9]\d{0,18}$/.test(scope.accountId)||BigInt(scope.accountId)>9223372036854775807n||!uuid(scope.grantId)||
  !Object.hasOwn(RECEPTION_HISTORY_DISCLOSURES,scope.purpose)||(scope.purpose==='context'?!uuid(scope.customerId):scope.customerId!==undefined))throw Error('history_scope_unavailable');
}
async function contextBinding(c:PoolClient,scope:AuthorizedHistoryScope){
 const customer=(await c.query('SELECT name,phone,email FROM customers WHERE tenant_id=$1 AND customer_id=$2',[scope.tenantId,scope.customerId])).rows;
 if(customer.length!==1||[customer[0].name,customer[0].phone,customer[0].email].some(v=>typeof v==='string'&&v.length>200))throw Error('history_scope_unavailable');
 const known=[customer[0].name,customer[0].phone,customer[0].email].filter((v):v is string=>typeof v==='string');
 const rows=(await c.query(`SELECT DISTINCT i.chatwoot_contact_id::text AS id FROM channel_identities i
  WHERE i.tenant_id=$1 AND i.customer_id=$2 AND i.sync_status='synced' AND i.chatwoot_contact_id IS NOT NULL
   AND i.channel IN('web_chat','shared_wechat','wechat_official_account')
   AND NOT EXISTS(SELECT 1 FROM channel_identities x WHERE x.tenant_id=i.tenant_id AND x.chatwoot_contact_id=i.chatwoot_contact_id
    AND x.customer_id<>i.customer_id AND x.sync_status='synced') ORDER BY id LIMIT 9`,[scope.tenantId,scope.customerId])).rows;
 const contacts=rows.map(r=>r.id as string);if(!contacts.length||contacts.length>8)throw Error('history_scope_unavailable');
 return {contacts,known};
}
/** Best-effort local masking, NOT a proof that arbitrary prose has no PII.
 * Historical text remains untrusted, never a substitute for approved KB facts.
 */
export function redactReceptionHistoryText(text:string,known:readonly string[]=[]):string{
 if(typeof text!=='string'||text.length>4000||known.length>3||known.some(v=>typeof v!=='string'||v.length>200))throw Error('history_privacy_unavailable');
 let value=text;for(const item of [...known].filter(v=>v.trim().length>=2).sort((a,b)=>b.length-a.length))value=value.split(item).join('[客户资料已隐藏]');
 return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,'[邮箱已隐藏]')
  .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu,'[电话已隐藏]')
  .replace(/(?<![A-Z0-9])\d{17}[0-9X](?![A-Z0-9])/giu,'[证件号码已隐藏]')
  .replace(/(?<!\d)\d{16,19}(?!\d)/gu,'[长号码已隐藏]')
  .replace(/(?:Bearer\s+[A-Za-z0-9._~+/-]{12,}|\bsk-[A-Za-z0-9_-]{12,})/giu,'[密钥已隐藏]')
  .replace(/(密码|验证码|收货地址|详细地址|微信号|姓名|银行账号|密钥|AppSecret|API[_ -]?Key|access_token|Token)\s*[:：]\s*[^\n。；;]{1,200}/giu,'$1：[敏感内容已隐藏]')
  .replace(/(https?:\/\/[^\s<>?]+)\?[^\s<>]+/giu,'$1?[链接参数已隐藏]');
}
async function checked<T>(db:Db,scope:AuthorizedHistoryScope,operation:(c:PoolClient)=>Promise<T>):Promise<T>{
 const c=await db.connect();try{
  await c.query('BEGIN READ ONLY');await c.query("SET LOCAL statement_timeout='2s';SET LOCAL lock_timeout='500ms'");
  if(!await currentReceptionHistoryGrant(c,scope.tenantId,scope.accountId,scope.purpose,scope.grantId))throw Error('history_authorization_unavailable');
  const result=await operation(c);await c.query('COMMIT');return result;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
/** Server-only authorized reader. Never retains a DB transaction while awaiting
 * native I/O, never traverses all users, never calls a model or publishes KB.
 * Three pages/600 scanned maximum; actual sample remains 80/20/16k bounded.
 */
export function createAuthorizedReceptionHistoryReader(db:Db,native:Port,options:{enabled?:()=>boolean}={}){
 const enabled=options.enabled??(()=>false);
 const read=async(raw:AuthorizedHistoryScope):Promise<AuthorizedHistorySample>=>{
  if(!enabled())throw Error('history_read_disabled');validate(raw);const scope=Object.freeze({...raw});
  const binding=await checked(db,scope,async c=>{
   const clock=(await c.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS as_of`)).rows[0].as_of as string;
   return {asOf:clock,...(scope.purpose==='context'?await contextBinding(c,scope):{contacts:[],known:[]})};
  });
  const fresh=()=>checked(db,scope,async c=>{
   if(scope.purpose==='context'){
    const current=await contextBinding(c,scope);
    if(JSON.stringify(current.contacts)!==JSON.stringify(binding.contacts)||JSON.stringify(current.known)!==JSON.stringify(binding.known))throw Error('history_scope_unavailable');
   }
  });
  let cursor:HistoryCursor|null=null,scanned=0,pages=0;let sample:readonly ReceptionHistoryMessage[]=[];
  const selection:ReceptionHistoryScope={tenantId:scope.tenantId,accountId:scope.accountId,purpose:scope.purpose,...(scope.customerId?{customerId:scope.customerId}:{})};
  const at=Date.parse(binding.asOf);if(!Number.isSafeInteger(at))throw Error('history_scope_unavailable');
  for(;pages<3;){
   if(!enabled())throw Error('history_read_disabled');
   await fresh();
   const result=await native.page({account_id:scope.accountId,purpose:scope.purpose,grant_id:scope.grantId,as_of:binding.asOf,contact_ids:binding.contacts,cursor});
   if(result.outcome!=='ready')throw Error('history_native_unavailable');
   if(!enabled())throw Error('history_read_disabled');await fresh();
   scanned+=result.page.scanned;pages++;
   const rows:ReceptionHistoryMessage[]=result.page.rows.map(r=>{
    if(scope.purpose==='context'&&!binding.contacts.includes(r.contact_id))throw Error('history_native_unavailable');
    return {tenantId:scope.tenantId,accountId:r.account_id,customerId:scope.customerId??r.contact_id,
     conversationId:r.conversation_id,messageId:r.message_id,createdAtMs:Date.parse(r.created_at),direction:r.direction,authorKind:r.author_kind,private:false,deleted:false,text:r.text};
   });
   // The native port validates exact scope/cursor; repeat pure policy isolation
   // before aggregating, preserving finite sample bounds across all pages.
   const selected=selectReceptionHistorySample(selection,rows,at);
   sample=selectReceptionHistorySample(selection,[...sample,...selected],at);
   cursor=result.page.next_cursor;if(!cursor||sample.length>=80||sample.reduce((sum,r)=>sum+r.text.length,0)>=16000)break;
  }
  await fresh();if(!enabled())throw Error('history_read_disabled');
  if(scope.purpose==='style')return Object.freeze({purpose:'style',style:suggestReceptionStyle(selection,sample,at),sampleDigest:digest(sample),scanned,pages,asOf:binding.asOf});
  // Masking can expand text; re-apply output limits without cutting a condition.
  const messages=selectReceptionHistorySample(selection,sample.map(r=>({...r,text:redactReceptionHistoryText(r.text,binding.known)})),at);
  const included=new Set(messages.map(r=>r.messageId));
  return Object.freeze({purpose:scope.purpose,messages,sampleDigest:digest(sample.filter(r=>included.has(r.messageId))),scanned,pages,asOf:binding.asOf,privacyPolicy:'history-redaction-v1'});
 };
 return {read:async(scope:AuthorizedHistoryScope)=>{try{return await read(scope);}catch(e){
  const code=e instanceof Error?e.message:'';
  throw Error(['history_read_disabled','history_scope_unavailable','history_authorization_unavailable','history_native_unavailable','history_privacy_unavailable'].includes(code)?code:'history_read_unavailable');
 }}};
}
