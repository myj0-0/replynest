import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {Pool} from 'pg';
import {stageAutomaticReception} from './automatic-reception-store.js';
import {automaticModeGuard} from './automatic-reception-mode.js';
/** Explicit migration prerequisite; this module never installs tables/indexes. */
export const automaticWechatIntakeSchema=`
 CREATE INDEX IF NOT EXISTS automatic_wechat_pending ON automatic_reception_jobs(created_at,job_id)
  WHERE state='queued' AND channel IN('wechat_official_account','shared_wechat');
 CREATE INDEX IF NOT EXISTS automatic_wechat_processed_scan ON gateway_events(processed_at,id)
  WHERE channel='wechat_official_account' AND status='processed';
 CREATE INDEX IF NOT EXISTS automatic_shared_processed_scan ON shared_wechat_deliveries(created_at,app_id,command_id)
  WHERE direction='in' AND status='delivered';
`;
/** Bounded database-only intake. Native snapshot in the adapter must still prove
 * latest incoming/human state BEFORE any model call. No callback/model-chosen IDs.
 * Same admission lock/caps as Web; no network or model under row/transaction locks.
 */
export function createAutomaticWeChatIntake(db:Pick<Pool,'connect'>,options:{enabled?:()=>boolean;monotonicNow?:()=>number}={}){
 const enabled=options.enabled??(()=>false);let active:Promise<number>|null=null,stopped=false;
 // Admission belongs to this running instance, not the last ten minutes of
 // traffic. Restarting must not turn messages received while closed into jobs.
 // Existing admitted jobs are deliberately untouched and remain resumable.
 // Anchor the cutoff in DATABASE time; a monotonic elapsed duration preserves
 // messages received between construction and the first tick without trusting
 // a possibly skewed application wall clock. Never persist a model-chosen time.
 const monotonicNow=options.monotonicNow??(()=>performance.now());
 let activated=enabled()?monotonicNow():null,admissionAt:string|null=null,admissionRevision=0;
 function available(){
  if(stopped||!enabled()){if(activated!==null)admissionRevision++;activated=null;admissionAt=null;return false;}
  if(activated===null){activated=monotonicNow();admissionRevision++;}
  return true;
 }
 async function run(){
  if(!available())return 0;
  const revision=admissionRevision;
  const c=await db.connect();try{
   await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms'");
   const lock=await c.query('SELECT pg_try_advisory_xact_lock(714201,1) held');
   if(!lock.rows[0].held||!available()||revision!==admissionRevision){await c.query('ROLLBACK');return 0;}
   if(admissionAt===null){
    const elapsed=Math.floor(monotonicNow()-activated!);
    if(!Number.isSafeInteger(elapsed)||elapsed<0)throw Error('invalid_wechat_admission_clock');
    const row=(await c.query(`SELECT CEIL(EXTRACT(EPOCH FROM clock_timestamp())*1000-$1::double precision)::text admission_ms`,[elapsed])).rows[0];
    const ms=Number(row?.admission_ms);
    if(!Number.isSafeInteger(ms)||ms<=0||ms>8640000000000000)throw Error('invalid_wechat_admission_clock');
    if(!available()||revision!==admissionRevision){await c.query('ROLLBACK');return 0;}
    admissionAt=new Date(ms).toISOString();
   }
   const global=Number((await c.query(`SELECT count(*) n FROM(SELECT 1 FROM automatic_reception_jobs
    WHERE state IN('queued','processing','submitting') LIMIT 1000) bounded`)).rows[0].n);
   if(global>=1000){await c.query('ROLLBACK');return 0;}
   const independent=`SELECT e.tenant_id,t.chatwoot_account_id::text account_id,i.chatwoot_conversation_id::text conversation_id,
    e.chatwoot_message_id::text message_id,i.customer_id,'wechat_official_account' channel,i.channel_connection_id connection_id,e.processed_at at
    FROM gateway_events e JOIN tenants t ON t.tenant_id=e.tenant_id
    JOIN automatic_reception_grants g ON g.tenant_id=t.tenant_id AND g.enabled AND g.account_id=t.chatwoot_account_id::text AND g.consent_version='automatic-send-v1'
    JOIN tenant_ai_settings s ON s.tenant_id=t.tenant_id
    JOIN automatic_reception_wechat_grants wg ON wg.tenant_id=g.tenant_id AND wg.authorization_id=g.authorization_id AND wg.enabled
     AND wg.consent_version='wechat-automatic-send-v1' AND 'wechat_official_account'=ANY(wg.channels)
    JOIN channel_connections conn ON conn.tenant_id=e.tenant_id AND conn.connection_id=e.channel_connection_id
    JOIN channel_identities i ON i.tenant_id=e.tenant_id AND i.channel='wechat_official_account' AND i.channel_connection_id=conn.connection_id
     AND i.external_user_id=e.payload->'normalized'->>'user_id'
    WHERE e.channel='wechat_official_account' AND e.status='processed' AND e.processed_at>NOW()-INTERVAL '10 minutes'
     AND NOT (e.payload->'normalized' ? 'media')
     AND e.created_at>=$1::timestamptz
     AND e.payload->'normalized'->>'occurred_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
     AND e.payload->'normalized'->>'occurred_at'>=$2::text
     AND t.status IN('active','test') AND ${automaticModeGuard} AND conn.status='ready' AND conn.channel_type=e.channel
     AND conn.configuration->>'chatwoot_account_id'=t.chatwoot_account_id::text
     AND i.customer_id IS NOT NULL AND i.chatwoot_contact_id IS NOT NULL AND i.chatwoot_conversation_id IS NOT NULL AND e.chatwoot_message_id IS NOT NULL
     AND e.payload->'normalized'->>'event_id'=e.external_event_id AND e.payload->'normalized'->>'message_id'=e.external_message_id
     AND NOT EXISTS(SELECT 1 FROM shared_wechat_accounts a WHERE a.app_id=conn.external_account_id AND a.enabled)
     AND NOT EXISTS(SELECT 1 FROM automatic_reception_jobs j WHERE j.tenant_id=e.tenant_id AND j.account_id=t.chatwoot_account_id::text AND j.message_id=e.chatwoot_message_id::text)
    ORDER BY e.processed_at,e.id LIMIT 20`;
   const shared=`SELECT d.tenant_id,t.chatwoot_account_id::text account_id,b.conversation_id::text conversation_id,
    d.upstream_message_id message_id,i.customer_id,'shared_wechat' channel,NULL::uuid connection_id,d.created_at at
    FROM shared_wechat_deliveries d JOIN shared_wechat_receipts r ON r.app_id=d.app_id AND r.event_id=d.command_id AND r.open_id=d.open_id AND r.destination_tenant_id=d.tenant_id
    JOIN tenants t ON t.tenant_id=d.tenant_id
    JOIN automatic_reception_grants g ON g.tenant_id=t.tenant_id AND g.enabled AND g.account_id=t.chatwoot_account_id::text AND g.consent_version='automatic-send-v1'
    JOIN tenant_ai_settings s ON s.tenant_id=t.tenant_id
    JOIN automatic_reception_wechat_grants wg ON wg.tenant_id=g.tenant_id AND wg.authorization_id=g.authorization_id AND wg.enabled
     AND wg.consent_version='wechat-automatic-send-v1' AND 'shared_wechat'=ANY(wg.channels)
    JOIN shared_wechat_threads b ON b.app_id=d.app_id AND b.tenant_id=d.tenant_id AND b.open_id=d.open_id AND b.account_id=t.chatwoot_account_id
    JOIN channel_identities i ON i.tenant_id=d.tenant_id AND i.channel='shared_wechat' AND i.channel_connection_id IS NULL
     AND i.chatwoot_contact_id=b.contact_id AND i.chatwoot_conversation_id=b.conversation_id
    WHERE d.direction='in' AND d.status='delivered' AND d.created_at>NOW()-INTERVAL '10 minutes'
     AND r.media_payload IS NULL
     AND r.source_occurred_at>=$1::timestamptz
     AND r.source_occurred_at>=GREATEST(g.updated_at,wg.created_at) AND r.source_occurred_at>NOW()-INTERVAL '10 minutes'
     AND r.source_occurred_at<=clock_timestamp() AND r.decision->>'action'='route' AND r.delivery_state='held'
     AND t.status IN('active','test') AND ${automaticModeGuard} AND i.customer_id IS NOT NULL AND d.upstream_message_id ~ '^[1-9][0-9]{0,18}$'
     AND NOT EXISTS(SELECT 1 FROM automatic_reception_jobs j WHERE j.tenant_id=d.tenant_id AND j.account_id=t.chatwoot_account_id::text AND j.message_id=d.upstream_message_id)
    ORDER BY d.created_at,d.app_id,d.command_id LIMIT 20`;
   // Distinct bind slots prevent PostgreSQL from re-serializing the timestamp
   // parameter as "YYYY-MM-DD HH:...+00" during canonical ISO-text comparison.
   const candidates=(await c.query(`SELECT * FROM ((${independent}) UNION ALL (${shared})) candidates ORDER BY at,tenant_id LIMIT 20`,[admissionAt,admissionAt])).rows;
   let count=0;const perTenant=new Map<string,number>();
   for(const r of candidates){
    if(count>=1000-global||!available()||revision!==admissionRevision)break;
    let pending=perTenant.get(r.tenant_id);
    if(pending===undefined)pending=Number((await c.query(`SELECT count(*) n FROM(SELECT 1 FROM automatic_reception_jobs WHERE tenant_id=$1
     AND state IN('queued','processing','submitting') LIMIT 100) bounded`,[r.tenant_id])).rows[0].n);
    if(pending>=100)continue;
    await stageAutomaticReception(c,{tenantId:r.tenant_id,jobId:randomUUID(),accountId:r.account_id,conversationId:r.conversation_id,
     messageId:r.message_id,customerId:r.customer_id,channel:r.channel,connectionId:r.connection_id});
    count++;perTenant.set(r.tenant_id,pending+1);
   }
   await c.query('COMMIT');return count;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 return {tick:()=>{if(!available()||active)return Promise.resolve(0);active=run();const p=active;void p.finally(()=>{if(active===p)active=null;}).catch(()=>{});return p;},
  stop:async()=>{stopped=true;await active;}};
}
