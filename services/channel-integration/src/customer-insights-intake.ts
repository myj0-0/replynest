import {randomUUID,createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {AutomaticInbound} from './automatic-reception-queue.js';
import {CUSTOMER_INSIGHTS_CONSENT} from './customer-insights-core.js';
import type {createCustomerInsightsStore} from './customer-insights-store.js';
import type {NativeInsightsHistoryRequest,NativeHistoryPage} from './reception-history-native-client.js';

type Db=Pick<Pool,'query'|'connect'>;
export type InsightIntake=AutomaticInbound&{tenantId:string;intakeId:string;grantId:string;generation:number;lease:string};
type Binding={tenant_id:string;grant_id:string;generation:number;channel:string;connection_id:string|null;authorized_at:string};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const uid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v);
const timestamp=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,23)===v.slice(0,23);
function valid(e:AutomaticInbound){if(!e||!['account','inbox','conversation','message'].every(k=>id(e[k as keyof AutomaticInbound])))throw Error('insights_intake_invalid');}
/** Durable metadata-only admission. The caller must authenticate the native
 * bridge (or verified WeChat delivery) first. A callback is NOT evidence for a
 * model: current grants and actual public native text are checked by runOne.
 * No dependence on tenant_ai_settings or automatic-send grants/modes. */
export function createCustomerInsightsIntakeStore(db:Db,options:{enabled?:()=>boolean;sharedEnabled?:()=>boolean}={}){
 const enabled=options.enabled??(()=>false);
 async function tx<T>(fn:(c:PoolClient)=>Promise<T>){const c=await db.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s';SET LOCAL lock_timeout='500ms'");const v=await fn(c);await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
 async function binding(c:Pick<PoolClient,'query'>,e:AutomaticInbound,lock=true):Promise<Binding|null>{
  valid(e);
  const shared=options.sharedEnabled?.()?`UNION ALL SELECT b.tenant_id,'shared_wechat' channel,NULL::uuid connection_id FROM shared_wechat_threads b
   JOIN shared_wechat_enrollments en ON en.tenant_id=b.tenant_id AND en.app_id=b.app_id AND en.enabled
   JOIN shared_wechat_accounts a ON a.app_id=b.app_id AND a.enabled
   JOIN shared_wechat_inboxes ib ON ib.app_id=b.app_id AND ib.tenant_id=b.tenant_id AND ib.enabled AND ib.account_id=b.account_id AND ib.inbox_id=b.inbox_id
   WHERE b.account_id=$1::bigint AND b.inbox_id=$2::bigint AND b.conversation_id=$4::bigint`:'';
  const r=await c.query(`SELECT t.tenant_id,s.grant_id,s.generation,ch.channel,ch.connection_id,
   to_char(s.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') authorized_at
   FROM (SELECT tenant_id,channel_type channel,connection_id FROM channel_connections WHERE status='ready'
    AND channel_type IN('web_chat','wechat_official_account') AND configuration->>'chatwoot_account_id'=$1::text AND configuration->>'chatwoot_inbox_id'=$2::text ${shared}) ch
   JOIN tenants t ON t.tenant_id=ch.tenant_id JOIN customer_insight_settings s ON s.tenant_id=t.tenant_id
   JOIN tenant_memberships m ON m.tenant_id=s.tenant_id AND m.platform_user_id=s.authorized_by
   JOIN platform_users u ON u.platform_user_id=m.platform_user_id
   WHERE t.chatwoot_account_id=$1::bigint AND t.status IN('active','test') AND s.account_id=$1::bigint AND s.enabled AND s.consent_version=$3
    AND m.chatwoot_account_id=$1::bigint AND m.role='tenant_admin' AND m.status='active' AND m.chatwoot_sync_status='synced' AND u.status='active'
   LIMIT 2 ${lock?'FOR SHARE OF t,s,m,u':''}`,[e.account,e.inbox,CUSTOMER_INSIGHTS_CONSENT,...(shared?[e.conversation]:[])]);
  if(r.rows.length>1)throw Error('insights_intake_ambiguous');return r.rows[0]??null;
 }
 async function current(c:Pick<PoolClient,'query'>,e:InsightIntake){
  const b=await binding(c,e);if(!b||b.tenant_id!==e.tenantId||b.grant_id!==e.grantId||b.generation!==e.generation)return null;
  const live=await c.query("SELECT 1 FROM customer_insight_intake WHERE intake_id=$1 AND state='processing' AND lease=$2 AND locked_at>clock_timestamp()-INTERVAL '2 minutes'",[e.intakeId,e.lease]);
  return live.rowCount===1?b:null;
 }
 return {
  admit:async(e:AutomaticInbound,expected?:{tenantId:string;grantId:string;generation:number}):Promise<'queued'|'ignored'|'backpressure'>=>{
   if(!enabled())return 'ignored';valid(e);
   return tx(async c=>{const before=await binding(c,e,false);if(!before||!enabled()||expected&&(before.tenant_id!==expected.tenantId||before.grant_id!==expected.grantId||before.generation!==expected.generation))return 'ignored';
    // Same lock order as configure/enqueue: tenant advisory BEFORE settings
    // row locks. Taking a grant share lock first can deadlock with revocation.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`customer-insights:${before.tenant_id}`]);
    const b=await binding(c,e);if(!b||b.tenant_id!==before.tenant_id||b.grant_id!==before.grant_id||b.generation!==before.generation)return 'ignored';
    if((await c.query('SELECT 1 FROM customer_insight_intake WHERE tenant_id=$1 AND account_id=$2 AND message_id=$3',[b.tenant_id,e.account,e.message])).rowCount)return 'queued';
    const n=(await c.query("SELECT count(*)::int n FROM (SELECT 1 FROM customer_insight_intake WHERE tenant_id=$1 AND state IN('pending','processing') LIMIT 200) q",[b.tenant_id])).rows[0].n;
    if(n>=200)return 'backpressure';
    if(!enabled())return 'ignored';
    await c.query(`INSERT INTO customer_insight_intake(tenant_id,account_id,inbox_id,conversation_id,message_id,grant_id,generation)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,account_id,message_id) DO NOTHING`,[b.tenant_id,e.account,e.inbox,e.conversation,e.message,b.grant_id,b.generation]);return 'queued';
   });
  },
  claim:async():Promise<InsightIntake|null>=>{
   if(!enabled())return null;return tx(async c=>{
    const lease=randomUUID(),r=(await c.query(`WITH candidate AS(SELECT intake_id FROM customer_insight_intake WHERE state='pending' AND due_at<=clock_timestamp()
     ORDER BY due_at,intake_id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE customer_insight_intake q SET state='processing',lease=$1,locked_at=clock_timestamp(),attempts=attempts+1
     FROM candidate c WHERE q.intake_id=c.intake_id RETURNING q.*`,[lease])).rows[0];
    return r?{account:String(r.account_id),inbox:String(r.inbox_id),conversation:String(r.conversation_id),message:String(r.message_id),
     tenantId:r.tenant_id,intakeId:r.intake_id,grantId:r.grant_id,generation:r.generation,lease}:null;
   });
  },
  context:async(e:InsightIntake)=>{
   if(!enabled())return null;return tx(async c=>{
    const b=await current(c,e);if(!b||!enabled())return null;
    const identities=(await c.query(`SELECT i.customer_id,i.chatwoot_contact_id::text contact_id FROM channel_identities i JOIN customers cu USING(customer_id)
     WHERE i.tenant_id=$1 AND cu.tenant_id=i.tenant_id AND i.channel=$2 AND i.chatwoot_conversation_id=$3 AND i.sync_status='synced'
     AND i.channel_connection_id IS NOT DISTINCT FROM $4::uuid AND i.customer_id IS NOT NULL AND i.chatwoot_contact_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM channel_identities x WHERE x.tenant_id=i.tenant_id AND x.chatwoot_contact_id=i.chatwoot_contact_id AND x.customer_id IS DISTINCT FROM i.customer_id)
     LIMIT 2 FOR SHARE OF i,cu`,[e.tenantId,b.channel,e.conversation,b.connection_id])).rows;
    if(identities.length>1)throw Error('insights_intake_ambiguous');
    const clock=(await c.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as_of`)).rows[0].as_of as string;
    return {binding:b,customerId:identities[0]?.customer_id as string|undefined,contactId:identities[0]?.contact_id as string|undefined,asOf:clock};
   });
  },
  // Only new Web Chat identities may be materialized here. The actual native
  // conversation read is a trusted server port, never callback/model JSON.
  projectWeb:async(e:InsightIntake,raw:unknown)=>{
   const r=raw as any,s=r?.meta?.sender;
   const native=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):id(v)?v:null;
   if(native(r?.account_id)!==e.account||native(r?.id)!==e.conversation||native(r?.inbox_id)!==e.inbox||!native(s?.id)||s.type!==undefined&&!['contact','Contact'].includes(s.type))throw Error('insights_projection_invalid');
   const contact=native(s.id)!;
   return tx(async c=>{const b=await current(c,e);if(!enabled()||!b||b.channel!=='web_chat')return false;
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`web-contact:${e.tenantId}:${contact}`]);
    const raced=(await c.query(`SELECT customer_id,chatwoot_contact_id::text contact_id,channel_connection_id FROM channel_identities
     WHERE tenant_id=$1 AND channel='web_chat' AND chatwoot_conversation_id=$2 LIMIT 2 FOR SHARE`,[e.tenantId,e.conversation])).rows;
    if(raced.length)return raced.length===1&&uid(raced[0].customer_id)&&raced[0].contact_id===contact&&raced[0].channel_connection_id===b.connection_id;
    const known=(await c.query(`SELECT DISTINCT customer_id FROM channel_identities WHERE tenant_id=$1 AND chatwoot_contact_id=$2 AND customer_id IS NOT NULL LIMIT 2`,[e.tenantId,contact])).rows;
    if(known.length>1)throw Error('insights_projection_ambiguous');
    const clean=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max&&!v.includes('\0')?v:null;
    const customer=known[0]?.customer_id??(await c.query('INSERT INTO customers(tenant_id,name,email,phone) VALUES($1,$2,$3,$4) RETURNING customer_id',
     [e.tenantId,clean(s.name,200)||'网站访客',clean(s.email,320),clean(s.phone_number,64)])).rows[0].customer_id;
    await c.query(`INSERT INTO channel_identities(tenant_id,customer_id,channel,external_user_id,chatwoot_contact_id,chatwoot_source_id,chatwoot_conversation_id,channel_connection_id)
     VALUES($1,$2,'web_chat',$3,$4,$5,$6,$7)`,[e.tenantId,customer,`${contact}:${e.conversation}`,contact,`web:${contact}`,e.conversation,b.connection_id]);return true;
   });
  },
  // No UI visit is required to create a shared-customer binding. Only the
  // persisted verified thread and this purpose's CURRENT grant may do so.
  projectShared:async(e:InsightIntake)=>{
   if(!enabled()||!options.sharedEnabled?.())return false;
   return tx(async c=>{const b=await current(c,e);if(!enabled()||!b||b.channel!=='shared_wechat')return false;
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`shared-profile:${e.tenantId}:${e.conversation}`]);
    const threads=(await c.query(`SELECT app_id,open_id,contact_id::text contact_id FROM shared_wechat_threads
     WHERE tenant_id=$1 AND account_id=$2 AND inbox_id=$3 AND conversation_id=$4 LIMIT 2 FOR SHARE`,[e.tenantId,e.account,e.inbox,e.conversation])).rows;
    if(threads.length!==1||!id(threads[0].contact_id))return false;const t=threads[0];
    const external=createHash('sha256').update(JSON.stringify([t.app_id,e.tenantId,t.open_id])).digest('hex');
    const known=(await c.query(`SELECT i.customer_id,i.chatwoot_contact_id::text contact_id,i.chatwoot_conversation_id::text conversation_id,i.channel_connection_id
     FROM channel_identities i JOIN customers cu ON cu.customer_id=i.customer_id AND cu.tenant_id=i.tenant_id
     WHERE i.tenant_id=$1 AND i.channel='shared_wechat' AND i.external_user_id=$2 LIMIT 2 FOR SHARE OF i,cu`,[e.tenantId,external])).rows;
    if(known.length){const k=known[0];if(known.length!==1||!uid(k.customer_id)||k.conversation_id!==e.conversation||k.channel_connection_id!==null||k.contact_id&&k.contact_id!==t.contact_id)return false;
     await c.query(`UPDATE channel_identities SET chatwoot_contact_id=$3 WHERE tenant_id=$1 AND channel='shared_wechat' AND external_user_id=$2 AND chatwoot_contact_id IS NULL`,[e.tenantId,external,t.contact_id]);return true;
    }
    // Do not merge an unverified contact into an existing customer's identity.
    if((await c.query('SELECT 1 FROM channel_identities WHERE tenant_id=$1 AND chatwoot_contact_id=$2 LIMIT 1',[e.tenantId,t.contact_id])).rowCount)return false;
    const customer=(await c.query("INSERT INTO customers(tenant_id,name) VALUES($1,'微信访客') RETURNING customer_id",[e.tenantId])).rows[0].customer_id;
    await c.query(`INSERT INTO channel_identities(tenant_id,customer_id,channel,external_user_id,chatwoot_source_id,chatwoot_conversation_id,chatwoot_contact_id)
     VALUES($1,$2,'shared_wechat',$3,$3,$4,$5)`,[e.tenantId,customer,external,e.conversation,t.contact_id]);return true;
   });
  },
  finish:async(e:InsightIntake,state:'done'|'ignored'|'retry')=>tx(async c=>{
   await c.query(`UPDATE customer_insight_intake SET state=CASE WHEN $3='retry' THEN CASE WHEN attempts>=8 THEN 'failed' ELSE 'pending' END ELSE $3 END,
    due_at=clock_timestamp()+LEAST(300,5*attempts*attempts)*INTERVAL '1 second',reason=CASE WHEN $3='retry' THEN 'verification_unavailable' ELSE NULL END
    WHERE intake_id=$1 AND state='processing' AND lease=$2`,[e.intakeId,e.lease,state]);
  }),
  recover:async()=>{if(!enabled())return 0;return tx(async c=>(await c.query(`WITH stale AS(SELECT intake_id FROM customer_insight_intake WHERE state='processing'
   AND locked_at<clock_timestamp()-INTERVAL '2 minutes' ORDER BY locked_at,intake_id FOR UPDATE SKIP LOCKED LIMIT 100)
   UPDATE customer_insight_intake q SET state=CASE WHEN attempts>=8 THEN 'failed' ELSE 'pending' END,due_at=clock_timestamp(),reason='verification_interrupted'
   FROM stale s WHERE q.intake_id=s.intake_id`)).rowCount??0);}
 };
}

type Native={page(input:NativeInsightsHistoryRequest):Promise<{outcome:'ready';page:NativeHistoryPage}|{outcome:'rejected'|'unavailable'}>};
export function createCustomerInsightsIntakeWorker(queue:ReturnType<typeof createCustomerInsightsIntakeStore>,store:Pick<ReturnType<typeof createCustomerInsightsStore>,'enqueue'>,
 ports:{enabled?:()=>boolean;native:Native;readConversation?:(e:AutomaticInbound)=>Promise<unknown>}){
 const enabled=ports.enabled??(()=>false);let busy=false;
 return {runOne:async()=>{
  if(busy||!enabled())return false;busy=true;let e:InsightIntake|null=null;
  try{
   e=await queue.claim();if(!e)return false;let context=await queue.context(e);
   if(!context||!enabled()){await queue.finish(e,'ignored');return true;}
   if(!context.contactId||!context.customerId){
    let projected=false;
    if(context.binding.channel==='shared_wechat')projected=await queue.projectShared(e);
    else if(context.binding.channel==='web_chat'&&ports.readConversation){const raw=await ports.readConversation(e);if(enabled())projected=await queue.projectWeb(e,raw);}
    else throw Error('insights_projection_pending');
    if(!enabled()||!projected){await queue.finish(e,'ignored');return true;}context=await queue.context(e);
   }
   if(!context||!id(context.contactId)||!uid(context.customerId)||!timestamp(context.asOf)||!timestamp(context.binding.authorized_at)||context.asOf<context.binding.authorized_at)throw Error('insights_projection_pending');
   const snapshot=context.asOf,contact=context.contactId,customer=context.customerId;
   const r=await ports.native.page({account_id:e.account,purpose:'customerInsights',grant_id:e.grantId,as_of:snapshot,contact_ids:[contact],
    cursor:null,after:{created_at:snapshot,message_id:'9223372036854775807'},event_ids:[e.message]});
   const fresh=await queue.context(e);
   if(!fresh||fresh.contactId!==contact||fresh.customerId!==customer||!enabled()){await queue.finish(e,'ignored');return true;}
   if(r.outcome!=='ready')throw Error('insights_native_verification_unavailable');
   const p=r.page,scan=p?.scan_cursor,seen=p?.event_seen_ids;
   // Recheck the injected transport too: only the fixed signed client is used
   // live, but a permissive test/adapter must not turn a callback into evidence.
   if(!p||Object.keys(p).sort().join(',')!=='event_seen_ids,next_cursor,rows,scan_cursor,scanned'||!Number.isInteger(p.scanned)||p.scanned<0||p.scanned>1||
    p.next_cursor!==null||!Array.isArray(p.rows)||p.rows.length>p.scanned||!Array.isArray(seen)||seen.length>1||seen.some(v=>v!==e!.message)||
    (p.scanned===0)!==(scan===null)||scan&&(!timestamp(scan.created_at)||scan.created_at>snapshot||Date.parse(scan.created_at)<Date.parse(snapshot)-30*86400000||scan.message_id!==e.message))throw Error('insights_native_verification_invalid');
   if(!r.page.rows.length){if(r.page.event_seen_ids?.includes(e.message)){await queue.finish(e,'ignored');return true;}throw Error('insights_source_not_visible');}
   const row=r.page.rows[0];
   if(!row||Object.keys(row).sort().join(',')!=='account_id,author_kind,contact_id,conversation_id,created_at,direction,inbox_id,message_id,text'||
    !timestamp(row.created_at)||row.created_at>snapshot||Date.parse(row.created_at)<Date.parse(snapshot)-30*86400000||scan?.created_at!==row.created_at||
    typeof row.text!=='string'||!row.text.trim()||[...row.text].length>2000||Buffer.byteLength(row.text)>8000||row.text.includes('\0')||Buffer.from(row.text).toString('utf8')!==row.text)throw Error('insights_native_verification_invalid');
   if(row.account_id!==e.account||row.conversation_id!==e.conversation||row.inbox_id!==e.inbox||row.message_id!==e.message||row.contact_id!==contact||
    row.direction!=='incoming'||row.author_kind!=='customer'||row.created_at<context.binding.authorized_at){await queue.finish(e,'ignored');return true;}
   const v=await store.enqueue({tenantId:e.tenantId,accountId:e.account,customerId:customer,conversationId:e.conversation,messageId:e.message},{grantId:e.grantId,generation:e.generation});
   await queue.finish(e,v.accepted?'done':'ignored');return true;
  }catch(error){if(!e)throw error;await queue.finish(e,'retry');return true;}finally{busy=false;}
 }};
}
