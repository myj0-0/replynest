import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {createCustomerInsightsIntakeStore} from './customer-insights-intake.js';
import {CUSTOMER_INSIGHTS_CONSENT} from './customer-insights-core.js';
type Db=Pick<Pool,'query'|'connect'>;
type Tx=Pick<PoolClient,'query'>;
export type InsightReceiptHooks={independent(c:Tx,id:string):Promise<void>;shared(c:Tx,appId:string,eventId:string):Promise<void>};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const time=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const micros=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(v)&&time(v.slice(0,23)+'Z');

/** SERVER-ONLY hooks run in the same transaction as the verified native receipt.
 * Caller IDs select persisted receipts, never an account/customer/model target.
 * Source/grant metadata survive a restart or intake backpressure. No body read,
 * native/model I/O or points operation occurs in these transactions. */
export function createCustomerInsightsSources(db:Db,intake:Pick<ReturnType<typeof createCustomerInsightsIntakeStore>,'admit'>,
 options:{enabled?:()=>boolean;sharedEnabled?:()=>boolean}={}){
 const enabled=options.enabled??(()=>false);let stopped=false,active:Promise<number>|null=null,epoch=0,wasEnabled=false;
 const available=()=>{const live=!stopped&&enabled();if(live!==wasEnabled){wasEnabled=live;epoch++;}return live;};
 const adminJoin=`JOIN customer_insight_settings s ON s.tenant_id=t.tenant_id AND s.enabled AND s.account_id=t.chatwoot_account_id AND s.consent_version=$3
  JOIN tenant_memberships m ON m.tenant_id=s.tenant_id AND m.platform_user_id=s.authorized_by AND m.role='tenant_admin' AND m.status='active' AND m.chatwoot_sync_status='synced' AND m.chatwoot_account_id=s.account_id
  JOIN platform_users u ON u.platform_user_id=m.platform_user_id AND u.status='active'`;
 const capture=async(c:Tx,kind:'independent'|'shared',first:string,second:string)=>{
  if(!available()||kind==='shared'&&!options.sharedEnabled?.())return;
  if(kind==='independent'&&!id(first)||kind==='shared'&&(!first||first.length>200||!second||second.length>255||/[\0\r\n]/.test(first+second)))throw Error('insights_receipt_invalid');
  const capturedEpoch=epoch;
  const independent=`SELECT t.tenant_id,t.chatwoot_account_id::text account_id,conn.configuration->>'chatwoot_inbox_id' inbox_id,
   i.chatwoot_conversation_id::text conversation_id,e.chatwoot_message_id::text message_id,s.grant_id,s.generation,e.payload->'normalized'->>'occurred_at' occurred_at,
   to_char(s.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cutoff,
   to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') current_time
   FROM gateway_events e JOIN tenants t ON t.tenant_id=e.tenant_id ${adminJoin}
   JOIN channel_connections conn ON conn.connection_id=e.channel_connection_id AND conn.tenant_id=e.tenant_id AND conn.channel_type='wechat_official_account' AND conn.status='ready'
   JOIN channel_identities i ON i.tenant_id=e.tenant_id AND i.channel=conn.channel_type AND i.channel_connection_id=conn.connection_id AND i.external_user_id=e.payload->'normalized'->>'user_id' AND i.sync_status='synced'
   WHERE e.id=$1::bigint AND $2::text='' AND e.channel='wechat_official_account' AND e.status='processed' AND t.status IN('active','test')
   AND conn.configuration->>'chatwoot_account_id'=t.chatwoot_account_id::text AND e.chatwoot_message_id IS NOT NULL
   AND i.chatwoot_contact_id IS NOT NULL AND i.chatwoot_conversation_id IS NOT NULL AND i.customer_id IS NOT NULL
   AND NOT(e.payload->'normalized' ? 'media') AND e.payload->'normalized'->>'event_id'=e.external_event_id AND e.payload->'normalized'->>'message_id'=e.external_message_id
   LIMIT 2`;
  const shared=`SELECT t.tenant_id,b.account_id::text account_id,b.inbox_id::text inbox_id,b.conversation_id::text conversation_id,d.upstream_message_id message_id,s.grant_id,s.generation,
   to_char(r.source_occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') occurred_at,
   to_char(s.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cutoff,
   to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') current_time
   FROM shared_wechat_deliveries d JOIN shared_wechat_receipts r ON r.app_id=d.app_id AND r.event_id=d.command_id AND r.open_id=d.open_id AND r.destination_tenant_id=d.tenant_id
   JOIN tenants t ON t.tenant_id=d.tenant_id ${adminJoin}
   JOIN shared_wechat_accounts a ON a.app_id=d.app_id AND a.enabled
   JOIN shared_wechat_enrollments en ON en.app_id=d.app_id AND en.tenant_id=d.tenant_id AND en.enabled
   JOIN shared_wechat_inboxes ib ON ib.app_id=d.app_id AND ib.tenant_id=d.tenant_id AND ib.enabled AND ib.account_id=t.chatwoot_account_id
   JOIN shared_wechat_threads b ON b.app_id=d.app_id AND b.tenant_id=d.tenant_id AND b.open_id=d.open_id AND b.account_id=ib.account_id AND b.inbox_id=ib.inbox_id
   WHERE d.app_id=$1 AND d.command_id=$2 AND d.direction='in' AND d.status='delivered' AND t.status IN('active','test')
   AND r.decision->>'action'='route' AND r.decision->>'tenantId'=d.tenant_id AND r.delivery_state='held' AND r.media_payload IS NULL AND b.contact_id IS NOT NULL LIMIT 2`;
  // No process-start watermark: an authorized receipt may finish after a restart.
  // This is a completion hook, not a scan/replay of historical business messages.
  const candidates=(await c.query(kind==='independent'?independent:shared,[first,second,CUSTOMER_INSIGHTS_CONSENT])).rows;
  if(candidates.length>1)throw Error('insights_receipt_ambiguous');const r=candidates[0];
  if(!r||!available()||epoch!==capturedEpoch||kind==='shared'&&!options.sharedEnabled?.()||![r.account_id,r.inbox_id,r.conversation_id,r.message_id].every(id))return;
  const occurred=kind==='independent'&&time(r.occurred_at)?r.occurred_at.slice(0,-1)+'000Z':r.occurred_at;
  if(!micros(occurred)||!micros(r.cutoff)||!micros(r.current_time)||occurred<r.cutoff||occurred>r.current_time)return;
  await c.query(`INSERT INTO customer_insight_sources(tenant_id,account_id,inbox_id,conversation_id,message_id,grant_id,generation,source_kind,source_key)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[r.tenant_id,r.account_id,r.inbox_id,r.conversation_id,r.message_id,r.grant_id,r.generation,kind,
   createHash('sha256').update(JSON.stringify([kind,first,second])).digest('hex')]);
 };
 async function tx<T>(work:(c:PoolClient)=>Promise<T>){const c=await db.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s';SET LOCAL lock_timeout='500ms'");const v=await work(c);await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
 const hooks:InsightReceiptHooks={independent:(c,key)=>capture(c,'independent',key,''),shared:(c,app,key)=>capture(c,'shared',app,key)};
 const run=async()=>{
  let count=0;
  for(let i=0;i<20&&available();i++){
   const lease=randomUUID(),r=await tx(async c=>(await c.query(`WITH next AS(SELECT source_id FROM customer_insight_sources WHERE state='pending' AND due_at<=clock_timestamp()
    ORDER BY due_at,source_id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE customer_insight_sources s SET state='processing',lease=$1,locked_at=clock_timestamp()
    FROM next n WHERE n.source_id=s.source_id RETURNING s.*`,[lease])).rows[0]);if(!r)break;
   let result:'queued'|'ignored'|'backpressure'='backpressure';
   try{if(available())result=await intake.admit({account:String(r.account_id),inbox:String(r.inbox_id),conversation:String(r.conversation_id),message:String(r.message_id)},
    {tenantId:r.tenant_id,grantId:r.grant_id,generation:r.generation});}
   catch{/* Metadata-only write can be safely retried; no provider has been called. */}
   await tx(c=>c.query(`UPDATE customer_insight_sources SET state=$3,due_at=clock_timestamp()+INTERVAL '5 seconds'
    WHERE source_id=$1 AND state='processing' AND lease=$2`,[r.source_id,lease,result==='backpressure'?'pending':result==='queued'?'done':'ignored']));count++;
  }return count;
 };
 const pump=()=>{if(!available()||active)return Promise.resolve(0);active=run();const p=active;void p.finally(()=>{if(active===p)active=null;}).catch(()=>{});return p;};
 const recover=async()=>{if(!available())return 0;return tx(async c=>(await c.query(`WITH stale AS(SELECT source_id FROM customer_insight_sources WHERE state='processing'
  AND locked_at<clock_timestamp()-INTERVAL '2 minutes' ORDER BY locked_at,source_id FOR UPDATE SKIP LOCKED LIMIT 100)
  UPDATE customer_insight_sources s SET state='pending',due_at=clock_timestamp() FROM stale x WHERE s.source_id=x.source_id`)).rowCount??0);};
 return {hooks,pump,recover,stop:async()=>{stopped=true;await active;}};
}
