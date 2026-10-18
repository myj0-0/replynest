import type {Pool} from 'pg';
import type {AutomaticInbound} from './automatic-reception-queue.js';
import {AUTOMATIC_SEND_CONSENT_VERSION} from './automatic-reply-policy.js';
import {automaticModeGuard} from './automatic-reception-mode.js';
type Db=Pick<Pool,'query'|'connect'>;
type Binding={tenant_id:string;connection_id:string;authorization_id:string};
const id=(v:unknown)=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)||typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):null;
/** Trusted, bounded native read only. Not a public-token/model-selected destination. */
export function createAutomaticProjectionReader(options:{origin:string;token:string;fetcher?:typeof fetch}){
 let origin:URL;try{origin=new URL(options.origin);}catch{throw Error('invalid_automatic_projection_config');}
 if(!['http:','https:'].includes(origin.protocol)||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password||
  !options.token||options.token.length>65536||/[\r\n\0]/.test(options.token))throw Error('invalid_automatic_projection_config');
 return async(e:AutomaticInbound):Promise<unknown>=>{
  if(![e.account,e.conversation].every(v=>id(v)===v))throw Error('invalid_automatic_projection_target');
  const r=await (options.fetcher??fetch)(`${origin.origin}/api/v1/accounts/${e.account}/conversations/${e.conversation}`,{
   headers:{api_access_token:options.token,accept:'application/json','x-forwarded-proto':'https'},redirect:'error',signal:AbortSignal.timeout(2000)});
  if(!r.ok||!r.body)throw Error('automatic_projection_unavailable');
  const reader=r.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>65536)throw Error('automatic_projection_body_limit');chunks.push(next.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw Error('automatic_projection_invalid');}
 };
}
/** Materialize one verified website visitor only; no transcript/model/points or sending.
 * Explicit grant and ready inbox binding are resolved before native API access and
 * rechecked under locks before writing. Ambiguity is retryable, absent consent is ignored.
 */
export function createAutomaticWebProjection(db:Db,options:{enabled?:()=>boolean;read:(e:AutomaticInbound)=>Promise<unknown>}){
 const enabled=options.enabled??(()=>false);
 const binding=async(e:AutomaticInbound,client:Pick<Pool,'query'>,lock=false):Promise<Binding|null>=>{
  const r=await client.query(`SELECT c.tenant_id,c.connection_id,g.authorization_id
   FROM channel_connections c JOIN tenants t USING(tenant_id) JOIN automatic_reception_grants g USING(tenant_id)
   JOIN tenant_ai_settings s USING(tenant_id)
   WHERE c.channel_type='web_chat' AND c.status='ready' AND t.status IN('active','test')
   AND t.chatwoot_account_id::text=$1 AND c.configuration->>'chatwoot_account_id'=$1 AND c.configuration->>'chatwoot_inbox_id'=$2
   AND g.enabled AND g.account_id=$1 AND g.consent_version=$3 AND ${automaticModeGuard} LIMIT 2 ${lock?'FOR SHARE OF c,t,g,s':''}`,
   [e.account,e.inbox,AUTOMATIC_SEND_CONSENT_VERSION]);
  if(r.rows.length>1)throw Error('automatic_projection_ambiguous');return r.rows[0]??null;
 };
 return async(e:AutomaticInbound):Promise<'ready'|'ignored'|'unavailable'>=>{
  if(!enabled())return 'ignored';
  try{
   const before=await binding(e,db);if(!before)return 'ignored';
   const existing=await db.query(`SELECT channel_connection_id,chatwoot_contact_id::text contact_id,customer_id
    FROM channel_identities WHERE tenant_id=$1 AND channel='web_chat' AND chatwoot_conversation_id::text=$2 LIMIT 2`,[before.tenant_id,e.conversation]);
   if(existing.rows.length){
    const i=existing.rows[0];return existing.rows.length===1&&i.channel_connection_id===before.connection_id&&id(i.contact_id)&&i.customer_id?'ready':'unavailable';
   }
   const raw=await options.read(e) as any,sender=raw?.meta?.sender;
   if(id(raw?.account_id)!==e.account||id(raw?.id)!==e.conversation||id(raw?.inbox_id)!==e.inbox||!id(sender?.id)||
    sender.type!==undefined&&!['contact','Contact'].includes(sender.type))return 'unavailable';
   const clean=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max&&!v.includes('\0')?v:null;
   const c=await db.connect();
   try{
    await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms'");
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`web-contact:${before.tenant_id}:${sender.id}`]);
    const current=await binding(e,c,true);
    if(!enabled()||!current||current.tenant_id!==before.tenant_id||current.connection_id!==before.connection_id||current.authorization_id!==before.authorization_id){await c.query('ROLLBACK');return 'ignored';}
    const raced=await c.query(`SELECT channel_connection_id,chatwoot_contact_id::text contact_id,customer_id FROM channel_identities
     WHERE tenant_id=$1 AND channel='web_chat' AND chatwoot_conversation_id::text=$2 LIMIT 2 FOR SHARE`,[before.tenant_id,e.conversation]);
    if(raced.rows.length){
     const i=raced.rows[0];const valid=raced.rows.length===1&&i.channel_connection_id===before.connection_id&&i.contact_id===id(sender.id)&&i.customer_id;
     await c.query('COMMIT');return valid?'ready':'unavailable';
    }
    const known=await c.query(`SELECT DISTINCT customer_id FROM channel_identities WHERE tenant_id=$1 AND channel='web_chat'
     AND chatwoot_contact_id::text=$2 AND customer_id IS NOT NULL LIMIT 2`,[before.tenant_id,id(sender.id)]);
    if(known.rows.length>1)throw Error('automatic_customer_projection_ambiguous');
    const customer=known.rows[0]?.customer_id??(await c.query(`INSERT INTO customers(tenant_id,name,email,phone) VALUES($1,$2,$3,$4) RETURNING customer_id`,
     [before.tenant_id,clean(sender.name,200)||'网站访客',clean(sender.email,320),clean(sender.phone_number,64)])).rows[0].customer_id;
    await c.query(`INSERT INTO channel_identities(tenant_id,customer_id,channel,external_user_id,chatwoot_contact_id,chatwoot_source_id,chatwoot_conversation_id,channel_connection_id)
     VALUES($1,$2,'web_chat',$3,$4,$5,$6,$7)`,[before.tenant_id,customer,`${sender.id}:${e.conversation}`,id(sender.id),`web:${sender.id}`,e.conversation,before.connection_id]);
    await c.query('COMMIT');return 'ready';
   }catch{await c.query('ROLLBACK').catch(()=>{});return 'unavailable';}finally{c.release();}
  }catch{return 'unavailable';}
 };
}
