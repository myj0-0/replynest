import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {validateInsightsSettings,CUSTOMER_INSIGHTS_CONSENT,validateInsightScope,INSIGHT_TOPICS,INSIGHT_PROFILE_CATEGORIES,insightInput,type CustomerInsight,type InsightMessage} from './customer-insights-core.js';
import type {InsightJob} from './customer-insights-worker.js';
import {parseInsightOutput} from './customer-insights-core.js';
import type {HistoryCursor} from './reception-history-native-client.js';

export type InsightsActor={tenantId:string;accountId:string;userId:string;role:'tenant_admin'|'supervisor'|'agent';impersonated:boolean};
export type VerifiedInsightEvent={tenantId:string;accountId:string;customerId:string;conversationId:string;messageId:string};
export type InsightReadBatch={cursor:HistoryCursor;hasMore:boolean;eventIds:string[]};
type Db=Pick<Pool,'connect'|'query'>;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v);
const native=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const tenant=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(v);
const exact=(v:object,keys:string[])=>Object.keys(v).sort().join(',')===keys.sort().join(',');
function eventInput(e:VerifiedInsightEvent){
 if(!e||!exact(e,['tenantId','accountId','customerId','conversationId','messageId'])||!tenant(e.tenantId)||!native(e.accountId)||!uuid(e.customerId)||!native(e.conversationId)||!native(e.messageId))throw Error('insights_event_invalid');
}
function jobInput(j:InsightJob){
 const {jobId,lease,...scope}=j;validateInsightScope(scope);if(!uuid(jobId)||!uuid(lease))throw Error('insights_job_invalid');
}
function actorInput(a:InsightsActor){
 if(!a||!tenant(a.tenantId)||!native(a.accountId)||!uuid(a.userId)||a.impersonated!==false||!['tenant_admin','supervisor','agent'].includes(a.role))throw Error('insights_identity_required');
}
function number(v:unknown){const n=Number(v);if(!Number.isSafeInteger(n)||n<0)throw Error('insights_record_invalid');return n;}

/** Storage only: deliberately NOT connected to a public callback, old history
 * consent or model. All upstream reads and point reservations must use the new
 * purpose adapter before the worker is enabled. No provider I/O inside a tx. */
export function createCustomerInsightsStore(db:Db,options:{authorizeCorrection?:(a:InsightsActor,e:Omit<VerifiedInsightEvent,'messageId'>)=>Promise<boolean>}={}){
 async function tx<T>(id:string,fn:(c:PoolClient)=>Promise<T>):Promise<T>{
  if(!tenant(id))throw Error('insights_tenant_invalid');const c=await db.connect();
  try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms'");
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`customer-insights:${id}`]);
   const result=await fn(c);await c.query('COMMIT');return result;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 async function seat(c:PoolClient,a:InsightsActor,admin=false){
  actorInput(a);if(admin&&a.role!=='tenant_admin')throw Error('insights_admin_required');
  const found=await c.query(`SELECT 1 FROM tenants t JOIN tenant_memberships m USING(tenant_id)
   JOIN platform_users u USING(platform_user_id) WHERE t.tenant_id=$1 AND t.chatwoot_account_id=$2
   AND t.status IN('active','test') AND m.platform_user_id=$3 AND m.chatwoot_account_id=$2
   AND m.status='active' AND m.chatwoot_sync_status='synced' AND m.role=$4 AND u.status='active'
   FOR SHARE OF t,m,u`,[a.tenantId,a.accountId,a.userId,a.role]);
  if(found.rowCount!==1)throw Error('insights_identity_required');
 }
 async function binding(c:PoolClient,e:Pick<VerifiedInsightEvent,'tenantId'|'accountId'|'customerId'|'conversationId'>){
  const r=await c.query(`SELECT 1 FROM tenants t JOIN customers cu USING(tenant_id)
   JOIN channel_identities i ON i.tenant_id=cu.tenant_id AND i.customer_id=cu.customer_id
   WHERE t.tenant_id=$1 AND t.chatwoot_account_id=$2 AND t.status IN('active','test') AND cu.customer_id=$3
   AND i.chatwoot_conversation_id=$4 AND i.sync_status='synced' AND i.chatwoot_contact_id IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM channel_identities other WHERE other.tenant_id=i.tenant_id
    AND other.chatwoot_contact_id=i.chatwoot_contact_id AND other.customer_id IS DISTINCT FROM i.customer_id)
   LIMIT 2`,[e.tenantId,e.accountId,e.customerId,e.conversationId]);
  return r.rowCount===1;
 }
 async function consent(c:PoolClient,id:string,account:string){
  return (await c.query(`SELECT s.* FROM customer_insight_settings s JOIN tenants t USING(tenant_id)
   JOIN tenant_memberships m ON m.tenant_id=s.tenant_id AND m.platform_user_id=s.authorized_by
   JOIN platform_users u USING(platform_user_id)
   WHERE s.tenant_id=$1 AND s.account_id=$2 AND s.enabled AND s.consent_version=$3
   AND t.chatwoot_account_id=s.account_id AND t.status IN('active','test')
   AND m.chatwoot_account_id=s.account_id AND m.role='tenant_admin' AND m.status='active'
   AND m.chatwoot_sync_status='synced' AND u.status='active' FOR SHARE OF s,t,m,u`,[id,account,CUSTOMER_INSIGHTS_CONSENT])).rows[0];
 }
 async function fence(c:PoolClient,j:InsightJob,states=['leased','calling']){
  jobInput(j);const s=await consent(c,j.tenantId,j.accountId);
  if(!s||s.grant_id!==j.grantId||number(s.generation)!==j.generation||!await binding(c,j))return false;
  return (await c.query(`SELECT 1 FROM customer_insight_jobs j JOIN customer_insight_profiles p
   ON p.tenant_id=j.tenant_id AND p.customer_id=j.customer_id WHERE j.job_id=$1 AND j.tenant_id=$2
   AND j.customer_id=$3 AND j.account_id=$4 AND j.conversation_id=$5 AND j.grant_id=$6 AND j.generation=$7
   AND j.revision=$8 AND j.lease=$9 AND j.state=ANY($10::text[]) AND j.lease_until>clock_timestamp()
   AND p.account_id=j.account_id AND p.revision=j.revision AND NOT p.suppressed`,
   [j.jobId,j.tenantId,j.customerId,j.accountId,j.conversationId,j.grantId,j.generation,j.revision,j.lease,states])).rowCount===1;
 }
 async function ownJob(c:PoolClient,j:InsightJob){
  // pg's default timestamptz parser truncates microseconds to JS milliseconds.
  // Keep exact sealed cursors for both replay comparison and checkpoint updates.
  jobInput(j);const r=(await c.query(`SELECT *,to_char(source_cursor_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_cursor_at,
   to_char(source_as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_as_of FROM customer_insight_jobs WHERE job_id=$1 AND tenant_id=$2
   AND account_id=$3 AND customer_id=$4 AND conversation_id=$5 AND grant_id=$6 AND generation=$7
   AND revision=$8 AND lease=$9 FOR UPDATE`,[j.jobId,j.tenantId,j.accountId,j.customerId,j.conversationId,j.grantId,j.generation,j.revision,j.lease])).rows[0];
  if(!r)throw Error('insights_job_fence');return r;
 }
 async function budget(c:PoolClient,j:InsightJob,ticket:string){
  if(!uuid(ticket))throw Error('insights_ticket_invalid');await ownJob(c,j);
  const b=(await c.query('SELECT *,budget_day::text AS budget_day_key FROM customer_insight_budget WHERE tenant_id=$1 AND job_id=$2 AND ticket=$3 FOR UPDATE',[j.tenantId,j.jobId,ticket])).rows[0];
  if(!b)throw Error('insights_budget_fence');return b;
 }
 async function advanceBatch(c:PoolClient,j:InsightJob,r:Record<string,any>){
  if(r.source_cursor_at){
   await c.query(`UPDATE customer_insight_profiles SET last_scan_at=$3,last_scan_id=$4
    WHERE tenant_id=$1 AND customer_id=$2 AND (last_scan_at IS NULL OR (last_scan_at,COALESCE(last_scan_id,0))<($3::timestamptz,$4::bigint))`,[j.tenantId,j.customerId,r.source_cursor_at,r.source_cursor_id]);
  }
  if(r.source_event_ids){
   await c.query(`INSERT INTO customer_insight_processed_events(tenant_id,account_id,message_id,job_id)
    SELECT tenant_id,account_id,message_id,$4 FROM customer_insight_events WHERE tenant_id=$1 AND account_id=$2 AND customer_id=$3 AND message_id=ANY($5::bigint[])
    ON CONFLICT(tenant_id,account_id,message_id) DO NOTHING`,[j.tenantId,j.accountId,j.customerId,j.jobId,r.source_event_ids]);
  }
  const backlog=r.source_event_ids&&(await c.query(`SELECT 1 FROM customer_insight_events e WHERE e.tenant_id=$1 AND e.customer_id=$2 AND e.account_id=$3
   AND NOT EXISTS(SELECT 1 FROM customer_insight_processed_events p WHERE p.tenant_id=e.tenant_id AND p.account_id=e.account_id AND p.message_id=e.message_id) LIMIT 1`,[j.tenantId,j.customerId,j.accountId])).rowCount;
  if(r.source_has_more||backlog){
   await c.query(`INSERT INTO customer_insight_jobs(tenant_id,customer_id,account_id,conversation_id,grant_id,generation,revision,due_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+INTERVAL '5 seconds') ON CONFLICT(tenant_id,customer_id) WHERE state='pending' DO NOTHING`,
    [j.tenantId,j.customerId,j.accountId,j.conversationId,j.grantId,j.generation,j.revision+1]);
  }
 }
 return {
  settings:async(a:InsightsActor)=>{
   actorInput(a);return tx(a.tenantId,async c=>{
    await seat(c,a,true);
    const s=(await c.query('SELECT enabled,revision,daily_budget_micros FROM customer_insight_settings WHERE tenant_id=$1 AND account_id=$2',[a.tenantId,a.accountId])).rows[0];
    const day=(await c.query(`SELECT (statement_timestamp() AT TIME ZONE 'Asia/Shanghai')::date::text AS budget_day_key,
     COALESCE(sum(charged_micros) FILTER(WHERE state='known'),0)::text charged,
     COALESCE(sum(estimated_micros) FILTER(WHERE state IN('held','calling','unknown')),0)::text held
     FROM customer_insight_budget WHERE tenant_id=$1 AND budget_day=(statement_timestamp() AT TIME ZONE 'Asia/Shanghai')::date`,[a.tenantId])).rows[0];
    const points=(n:unknown)=>{const value=BigInt(String(n));return `${value/1000000n}.${(value%1000000n).toString().padStart(6,'0')}`;};
    return {enabled:s?.enabled??false,grant_active:!!await consent(c,a.tenantId,a.accountId),revision:s?number(s.revision):0,
     daily_budget_points:points(s?.daily_budget_micros??10000000),consent_version:CUSTOMER_INSIGHTS_CONSENT,
     budget_day:day.budget_day_key,charged_points:points(day.charged),held_points:points(day.held)};
   });
  },
  configure:async(a:InsightsActor,raw:unknown)=>{
   actorInput(a);const v=validateInsightsSettings(raw,a.role,a.impersonated);
   return tx(a.tenantId,async c=>{
    await seat(c,a,true);const old=(await c.query('SELECT * FROM customer_insight_settings WHERE tenant_id=$1 FOR UPDATE',[a.tenantId])).rows[0];
    if((old?number(old.revision):0)!==v.revision)throw Error('insights_revision_conflict');
    const revision=v.revision+1,generation=(old?number(old.generation):0)+1,grant=randomUUID();
    const result=(await c.query(`INSERT INTO customer_insight_settings
     (tenant_id,account_id,enabled,daily_budget_micros,consent_version,grant_id,generation,revision,authorized_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id) DO UPDATE SET account_id=EXCLUDED.account_id,
     enabled=EXCLUDED.enabled,daily_budget_micros=EXCLUDED.daily_budget_micros,consent_version=EXCLUDED.consent_version,
     grant_id=EXCLUDED.grant_id,generation=EXCLUDED.generation,revision=EXCLUDED.revision,
     authorized_by=EXCLUDED.authorized_by,updated_at=clock_timestamp() RETURNING *`,
     [a.tenantId,a.accountId,v.enabled,v.budgetMicros,v.consentVersion,grant,generation,revision,a.userId])).rows[0];
    // In-flight calling jobs retain their identity for cost reconciliation. The
    // fresh generation fence stops publication; they must not be reset/retried.
    await c.query(`UPDATE customer_insight_jobs SET state='revoked',completed_at=clock_timestamp()
     WHERE tenant_id=$1 AND state='pending'`,[a.tenantId]);
    await c.query(`INSERT INTO customer_insight_audit(tenant_id,actor_id,action,revision) VALUES($1,$2,$3,$4)`,[a.tenantId,a.userId,v.enabled?'authorize':'revoke',revision]);
    return result;
   });
  },
  enqueue:async(e:VerifiedInsightEvent,expected?:{grantId:string;generation:number})=>{
   eventInput(e);return tx(e.tenantId,async c=>{
    const s=await consent(c,e.tenantId,e.accountId);if(!s||expected&&(s.grant_id!==expected.grantId||number(s.generation)!==expected.generation)||!await binding(c,e))return {accepted:false,duplicate:false};
    const previous=(await c.query('SELECT job_id FROM customer_insight_events WHERE tenant_id=$1 AND account_id=$2 AND message_id=$3',[e.tenantId,e.accountId,e.messageId])).rows[0];
    if(previous)return {accepted:true,duplicate:true};
    const p=(await c.query(`INSERT INTO customer_insight_profiles(tenant_id,customer_id,account_id)
     VALUES($1,$2,$3) ON CONFLICT(tenant_id,customer_id) DO UPDATE SET customer_id=EXCLUDED.customer_id RETURNING *`,[e.tenantId,e.customerId,e.accountId])).rows[0];
    if(p.suppressed||String(p.account_id)!==e.accountId)return {accepted:false,duplicate:false};
    // Backpressure bounds live jobs, not a tenant's historical customer count.
    const pending=(await c.query("SELECT 1 FROM customer_insight_jobs WHERE tenant_id=$1 AND customer_id=$2 AND state='pending'",[e.tenantId,e.customerId])).rowCount;
    if(!pending&&number((await c.query("SELECT count(*) n FROM customer_insight_jobs WHERE tenant_id=$1 AND state IN('pending','leased','calling')",[e.tenantId])).rows[0].n)>=100)throw Error('insights_backpressure');
    const job=(await c.query(`INSERT INTO customer_insight_jobs(tenant_id,customer_id,account_id,conversation_id,grant_id,generation,revision,due_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+INTERVAL '5 seconds')
     ON CONFLICT(tenant_id,customer_id) WHERE state='pending' DO UPDATE SET
      conversation_id=EXCLUDED.conversation_id,event_count=LEAST(10000,customer_insight_jobs.event_count+1),
      due_at=LEAST(customer_insight_jobs.created_at+INTERVAL '60 seconds',clock_timestamp()+INTERVAL '5 seconds')
     RETURNING job_id`,[e.tenantId,e.customerId,e.accountId,e.conversationId,s.grant_id,s.generation,p.revision])).rows[0];
    await c.query(`INSERT INTO customer_insight_events(tenant_id,account_id,message_id,customer_id,job_id) VALUES($1,$2,$3,$4,$5)`,[e.tenantId,e.accountId,e.messageId,e.customerId,job.job_id]);
    return {accepted:true,duplicate:false};
   });
  },
  claim:async():Promise<InsightJob|null>=>{
   const candidate=(await db.query(`SELECT tenant_id,job_id FROM customer_insight_jobs j WHERE state='pending' AND due_at<=clock_timestamp()
    AND NOT EXISTS(SELECT 1 FROM customer_insight_jobs a WHERE a.tenant_id=j.tenant_id AND a.customer_id=j.customer_id AND a.state IN('leased','calling'))
    AND NOT EXISTS(SELECT 1 FROM customer_insight_jobs a JOIN customer_insight_budget b USING(job_id) WHERE a.tenant_id=j.tenant_id AND a.customer_id=j.customer_id AND b.state='unknown')
    ORDER BY due_at,job_id LIMIT 1`)).rows[0];if(!candidate)return null;
   return tx(candidate.tenant_id,async c=>{
    const r=(await c.query(`SELECT * FROM customer_insight_jobs WHERE tenant_id=$1 AND job_id=$2 AND state='pending' AND due_at<=clock_timestamp() FOR UPDATE`,[candidate.tenant_id,candidate.job_id])).rows[0];if(!r)return null;
    const s=await consent(c,r.tenant_id,String(r.account_id));
    const p=(await c.query('SELECT * FROM customer_insight_profiles WHERE tenant_id=$1 AND customer_id=$2 FOR UPDATE',[r.tenant_id,r.customer_id])).rows[0];
    const base={tenantId:r.tenant_id,accountId:String(r.account_id),customerId:r.customer_id,conversationId:String(r.conversation_id),grantId:r.grant_id,generation:number(r.generation),revision:number(p.revision)};
    if(!s||s.grant_id!==r.grant_id||number(s.generation)!==base.generation||p.suppressed||String(p.account_id)!==base.accountId||!await binding(c,base)){
     await c.query("UPDATE customer_insight_jobs SET state='revoked',completed_at=clock_timestamp() WHERE job_id=$1",[r.job_id]);return null;
    }
    if((await c.query("SELECT 1 FROM customer_insight_jobs WHERE tenant_id=$1 AND customer_id=$2 AND state IN('leased','calling')",[r.tenant_id,r.customer_id])).rowCount)return null;
    if((await c.query(`SELECT 1 FROM customer_insight_jobs a JOIN customer_insight_budget b USING(job_id) WHERE a.tenant_id=$1 AND a.customer_id=$2 AND b.state='unknown' LIMIT 1`,[r.tenant_id,r.customer_id])).rowCount)return null;
    const lease=randomUUID();await c.query(`UPDATE customer_insight_jobs SET state='leased',revision=$2,lease=$3,lease_until=clock_timestamp()+INTERVAL '5 minutes' WHERE job_id=$1`,[r.job_id,base.revision,lease]);
    return {...base,jobId:r.job_id,lease};
   });
  },
  authorized:async(j:InsightJob)=>{jobInput(j);return tx(j.tenantId,c=>fence(c,j));},
  budgetState:async(j:InsightJob,ticket?:string)=>{
   jobInput(j);return tx(j.tenantId,async c=>{
    await ownJob(c,j);const b=ticket?await budget(c,j,ticket):(await c.query('SELECT * FROM customer_insight_budget WHERE tenant_id=$1 AND job_id=$2',[j.tenantId,j.jobId])).rows[0];
    if(!b)return null;return {ticket:String(b.ticket),state:String(b.state),aiCallId:b.ai_call_id as string|null,estimatedMicros:number(b.estimated_micros)};
   });
  },
  sourceState:async(j:InsightJob)=>{
   jobInput(j);return tx(j.tenantId,async c=>{
    if(!await fence(c,j,['leased']))throw Error('insights_job_fence');
    return (await c.query('SELECT ai_facts FROM customer_insight_profiles WHERE tenant_id=$1 AND customer_id=$2',[j.tenantId,j.customerId])).rows[0].ai_facts;
   });
  },
  readContext:async(j:InsightJob)=>{
   jobInput(j);return tx(j.tenantId,async c=>{
    if(!await fence(c,j,['leased']))throw Error('insights_job_fence');
    const p=(await c.query(`SELECT p.ai_facts,p.last_scan_id::text,to_char(p.last_scan_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_scan_at,
     cu.name,cu.phone,cu.email FROM customer_insight_profiles p JOIN customers cu ON cu.tenant_id=p.tenant_id AND cu.customer_id=p.customer_id
     WHERE p.tenant_id=$1 AND p.customer_id=$2`,[j.tenantId,j.customerId])).rows[0];
    const contacts=(await c.query(`SELECT DISTINCT i.chatwoot_contact_id::text AS id FROM channel_identities i
     WHERE i.tenant_id=$1 AND i.customer_id=$2 AND i.sync_status='synced' AND i.chatwoot_contact_id IS NOT NULL
     AND i.channel IN('web_chat','shared_wechat','wechat_official_account')
     AND NOT EXISTS(SELECT 1 FROM channel_identities other WHERE other.tenant_id=i.tenant_id AND other.chatwoot_contact_id=i.chatwoot_contact_id
      AND other.customer_id IS DISTINCT FROM i.customer_id) ORDER BY id LIMIT 9`,[j.tenantId,j.customerId])).rows.map(r=>String(r.id));
    if(!contacts.length||contacts.length>8||contacts.some(id=>!native(id)))throw Error('insights_source_binding_invalid');
    const known=[p.name,p.phone,p.email].filter((v):v is string=>typeof v==='string');if(known.some(s=>s.length>200))throw Error('insights_source_binding_invalid');
    const asOf=(await c.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS as_of`)).rows[0].as_of as string;
    const events=(await c.query(`SELECT e.message_id::text FROM customer_insight_events e WHERE e.tenant_id=$1 AND e.customer_id=$2 AND e.account_id=$3
     AND NOT EXISTS(SELECT 1 FROM customer_insight_processed_events p WHERE p.tenant_id=e.tenant_id AND p.account_id=e.account_id AND p.message_id=e.message_id)
     ORDER BY e.message_id LIMIT 100`,[j.tenantId,j.customerId,j.accountId])).rows.map(r=>String(r.message_id));
    return {previous:p.ai_facts,known,contacts,asOf,lastScanAt:p.last_scan_at as string|null,after:p.last_scan_at?{created_at:p.last_scan_at as string,message_id:p.last_scan_id??'9223372036854775807'}:null,eventMessageIds:events};
   });
  },
  // Called only AFTER independently authorized native history reads. Store IDs,
  // never transcript text. Existing same-customer facts keep their old evidence.
  sealEvidence:async(j:InsightJob,rows:InsightMessage[],asOf?:string,batch?:InsightReadBatch)=>{
   jobInput(j);return tx(j.tenantId,async c=>{
    if(!await fence(c,j,['leased']))return false;const r=await ownJob(c,j);
    const previous=(await c.query('SELECT ai_facts FROM customer_insight_profiles WHERE tenant_id=$1 AND customer_id=$2',[j.tenantId,j.customerId])).rows[0].ai_facts;
    const {jobId:_id,lease:_lease,...scope}=j,input=rows.length?insightInput(scope,rows,previous):{evidence:new Set<string>(previous.flatMap((f:{evidence_ids:string[]})=>f.evidence_ids)),currentEvidence:new Set<string>()};
    const all=[...input.evidence].sort(),current=[...input.currentEvidence].sort();
    if(asOf!==undefined&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(asOf)||!Number.isFinite(Date.parse(asOf))||rows.some(r=>Date.parse(r.createdAt)>Date.parse(asOf))))throw Error('insights_source_snapshot_invalid');
    if(batch){
     if(!asOf||!batch.cursor||!native(batch.cursor.message_id)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(batch.cursor.created_at)||!Number.isFinite(Date.parse(batch.cursor.created_at))||batch.cursor.created_at>asOf||typeof batch.hasMore!=='boolean'||!Array.isArray(batch.eventIds)||batch.eventIds.length>100||batch.eventIds.some(id=>!native(id))||new Set(batch.eventIds).size!==batch.eventIds.length)throw Error('insights_batch_invalid');
     const count=(await c.query(`SELECT count(*) n FROM customer_insight_events WHERE tenant_id=$1 AND customer_id=$2 AND account_id=$3 AND message_id=ANY($4::bigint[])`,[j.tenantId,j.customerId,j.accountId,batch.eventIds])).rows[0].n;
     if(number(count)!==batch.eventIds.length)throw Error('insights_batch_events_invalid');
    }
    if(r.evidence_ids){if(JSON.stringify(r.evidence_ids)!==JSON.stringify(all)||JSON.stringify(r.current_evidence_ids)!==JSON.stringify(current)||r.source_row_count!==rows.length||asOf!==undefined&&r.source_as_of!==asOf||batch&&(String(r.source_cursor_id)!==batch.cursor.message_id||r.source_cursor_at!==batch.cursor.created_at||r.source_has_more!==batch.hasMore||JSON.stringify(r.source_event_ids)!==JSON.stringify(batch.eventIds)))throw Error('insights_evidence_immutable');return true;}
    await c.query(`UPDATE customer_insight_jobs SET evidence_ids=$2,current_evidence_ids=$3,source_as_of=COALESCE($4::timestamptz,clock_timestamp()),
     source_cursor_at=$5,source_cursor_id=$6,source_has_more=$7,source_event_ids=$8,source_row_count=$9 WHERE job_id=$1`,[j.jobId,JSON.stringify(all),JSON.stringify(current),asOf??null,batch?.cursor.created_at??asOf??null,batch?.cursor.message_id??(asOf?'9223372036854775807':null),batch?.hasMore??false,batch?JSON.stringify(batch.eventIds):null,rows.length]);return true;
   });
  },
  reserveBudget:async(j:InsightJob,estimate:number)=>{
   jobInput(j);if(!Number.isSafeInteger(estimate)||estimate<1||estimate>10000000000)throw Error('insights_budget_invalid');
   return tx(j.tenantId,async c=>{
    if(!await fence(c,j,['leased']))return null;
    const old=(await c.query('SELECT * FROM customer_insight_budget WHERE tenant_id=$1 AND job_id=$2',[j.tenantId,j.jobId])).rows[0];
    if(old){if(number(old.estimated_micros)!==estimate||old.state!=='held')throw Error('insights_reservation_conflict');return {ticket:old.ticket};}
    const daily=(await c.query(`SELECT (statement_timestamp() AT TIME ZONE 'Asia/Shanghai')::date::text AS budget_day_key,
     COALESCE(sum(CASE WHEN state='known' THEN charged_micros WHEN state IN('held','calling','unknown') THEN estimated_micros ELSE 0 END),0)::text used
     FROM customer_insight_budget WHERE tenant_id=$1 AND budget_day=(statement_timestamp() AT TIME ZONE 'Asia/Shanghai')::date`,[j.tenantId])).rows[0];
    const limit=number((await consent(c,j.tenantId,j.accountId)).daily_budget_micros);
    if(BigInt(daily.used)+BigInt(estimate)>BigInt(limit))return null;
    const result=(await c.query(`INSERT INTO customer_insight_budget(job_id,tenant_id,budget_day,estimated_micros) VALUES($1,$2,$3,$4) RETURNING ticket`,[j.jobId,j.tenantId,daily.budget_day_key,estimate])).rows[0];
    return {ticket:result.ticket as string};
   });
  },
  // Only attach an actual durable AI ledger reservation for this exact job key.
  // The future adapter may recover a lost reserve acknowledgement by that key;
  // it must never generate a fresh key and pay for the same job twice.
  attachPoints:async(j:InsightJob,ticket:string,callId:string)=>{
   jobInput(j);if(!uuid(callId))throw Error('insights_call_invalid');return tx(j.tenantId,async c=>{
    const b=await budget(c,j,ticket);if(b.state!=='held'||!await fence(c,j,['leased']))return false;
    const call=(await c.query(`SELECT * FROM ai_usage_calls WHERE tenant_id=$1 AND call_id=$2 AND request_key=$3 AND feature='copilot' AND status='reserved' FOR SHARE`,[j.tenantId,callId,`customer-insights:${j.jobId}`])).rows[0];
    if(!call||number(call.reserved_micros)!==number(b.estimated_micros)||b.ai_call_id&&b.ai_call_id!==callId)throw Error('insights_points_binding_invalid');
    await c.query('UPDATE customer_insight_budget SET ai_call_id=$2 WHERE ticket=$1',[ticket,callId]);return true;
   });
  },
  beginModel:async(j:InsightJob,ticket:string)=>{
   jobInput(j);return tx(j.tenantId,async c=>{
    const b=await budget(c,j,ticket),r=await ownJob(c,j);if(b.state!=='held'||!b.ai_call_id||!r.source_row_count||!r.evidence_ids?.length||!r.current_evidence_ids||!await fence(c,j,['leased']))return false;
    // Do not start yesterday's held work using yesterday's daily allowance.
    const day=(await c.query("SELECT (statement_timestamp() AT TIME ZONE 'Asia/Shanghai')::date::text AS budget_day_key")).rows[0].budget_day_key;
    if(b.budget_day_key!==day)return false;
    const ok=(await c.query("SELECT 1 FROM ai_usage_calls WHERE tenant_id=$1 AND call_id=$2 AND status='reserved'",[j.tenantId,b.ai_call_id])).rowCount;
    if(!ok)return false;
    await c.query("UPDATE customer_insight_jobs SET state='calling' WHERE job_id=$1",[j.jobId]);
    await c.query("UPDATE customer_insight_budget SET state='calling' WHERE ticket=$1",[ticket]);return true;
   });
  },
  settleBudget:async(j:InsightJob,ticket:string,state:'known'|'not_called'|'unknown')=>{
   jobInput(j);if(!['known','not_called','unknown'].includes(state))throw Error('insights_settlement_invalid');
   return tx(j.tenantId,async c=>{
    const b=await budget(c,j,ticket);if(b.state===state)return;
    if(['known','not_called'].includes(b.state))throw Error('insights_settlement_conflict');
    const call=b.ai_call_id?(await c.query('SELECT * FROM ai_usage_calls WHERE tenant_id=$1 AND call_id=$2 FOR SHARE',[j.tenantId,b.ai_call_id])).rows[0]:null;
    let charged=0;
    if(state==='known'){
     if(!['calling','unknown'].includes(b.state)||!call||call.status!=='succeeded'||call.charged_micros===null)throw Error('insights_points_not_settled');
     charged=number(call.charged_micros);if(charged>number(b.estimated_micros))throw Error('insights_charge_overrun');
    }else if(state==='not_called'){
     if(b.state!=='held'||call&&(call.status!=='failed'||number(call.charged_micros)!==0))throw Error('insights_unused_reservation_required');
    }else if(b.state!=='calling'||!call)throw Error('insights_calling_required');
    await c.query('UPDATE customer_insight_budget SET state=$2,charged_micros=$3 WHERE ticket=$1',[ticket,state,charged]);
   });
  },
  save:async(j:InsightJob,result:CustomerInsight)=>{
   jobInput(j);return tx(j.tenantId,async c=>{
    if(!await fence(c,j,['calling']))return false;
    if(!(await c.query("SELECT 1 FROM customer_insight_budget WHERE tenant_id=$1 AND job_id=$2 AND state='known'",[j.tenantId,j.jobId])).rowCount)throw Error('insights_points_not_settled');
    const r=await ownJob(c,j);if(!r.evidence_ids||!r.current_evidence_ids)throw Error('insights_source_missing');
    const checked=parseInsightOutput(JSON.stringify(result),new Set<string>(r.evidence_ids),new Set<string>(r.current_evidence_ids));
    await c.query(`UPDATE customer_insight_profiles SET ai_facts=$3,revision=revision+1,updated_at=clock_timestamp()
     WHERE tenant_id=$1 AND customer_id=$2 AND revision=$4 AND NOT suppressed`,[j.tenantId,j.customerId,JSON.stringify(checked.long_term),j.revision]);
    if(checked.current_issue)await c.query(`INSERT INTO customer_insight_summaries(tenant_id,customer_id,conversation_id,ai_issue,topic)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,customer_id,conversation_id) DO UPDATE SET
     ai_issue=EXCLUDED.ai_issue,topic=EXCLUDED.topic,updated_at=clock_timestamp()`,[j.tenantId,j.customerId,j.conversationId,JSON.stringify(checked.current_issue),checked.topic]);
    await c.query("UPDATE customer_insight_jobs SET state='saved',completed_at=clock_timestamp() WHERE job_id=$1",[j.jobId]);await advanceBatch(c,j,r);return true;
   });
  },
  skipBatch:async(j:InsightJob)=>{
   jobInput(j);return tx(j.tenantId,async c=>{
    if(!await fence(c,j,['leased']))return false;const r=await ownJob(c,j);
    if(!r.evidence_ids||r.source_row_count!==0||r.current_evidence_ids?.length||!r.source_event_ids||!r.source_cursor_at||(await c.query('SELECT 1 FROM customer_insight_budget WHERE job_id=$1',[j.jobId])).rowCount)throw Error('insights_skip_requires_uncalled_batch');
    await c.query('UPDATE customer_insight_profiles SET revision=revision+1 WHERE tenant_id=$1 AND customer_id=$2',[j.tenantId,j.customerId]);
    await c.query("UPDATE customer_insight_jobs SET state='skipped',completed_at=clock_timestamp() WHERE job_id=$1",[j.jobId]);await advanceBatch(c,j,r);return true;
   });
  },
  finish:async(j:InsightJob,state:'saved'|'revoked'|'budget_exhausted'|'rejected'|'uncertain')=>{
   jobInput(j);if(!['saved','revoked','budget_exhausted','rejected','uncertain'].includes(state))throw Error('insights_finish_invalid');
   return tx(j.tenantId,async c=>{
    const r=await ownJob(c,j);if(!['leased','calling'].includes(r.state))return;
    if(state==='saved')throw Error('insights_saved_transaction_required');
    const b=(await c.query('SELECT * FROM customer_insight_budget WHERE tenant_id=$1 AND job_id=$2',[j.tenantId,j.jobId])).rows[0];
    if(b&&['held','calling'].includes(b.state))throw Error('insights_unsettled_budget');
    if(b?.state==='unknown'&&state!=='uncertain')throw Error('insights_uncertain_required');
    await c.query('UPDATE customer_insight_jobs SET state=$2,completed_at=clock_timestamp() WHERE job_id=$1',[j.jobId,state]);
   });
  },
  correct:async(a:InsightsActor,e:Omit<VerifiedInsightEvent,'messageId'>,revision:number,change:{action:'correct';facts:string[];issue:string}|{action:'delete'|'resume'})=>{
   actorInput(a);eventInput({...e,messageId:'1'});
   if(e.tenantId!==a.tenantId||e.accountId!==a.accountId||!Number.isSafeInteger(revision)||revision<0)throw Error('insights_revision_conflict');
   if(!change||!['correct','delete','resume'].includes(change.action)||!exact(change,change.action==='correct'?['action','facts','issue']:['action']))throw Error('insights_correction_invalid');
   if(change.action==='correct'&&(!Array.isArray(change.facts)||change.facts.length>12||change.facts.some(s=>typeof s!=='string'||!s.trim()||s.length>200)||typeof change.issue!=='string'||change.issue.length>600))throw Error('insights_correction_invalid');
   return tx(a.tenantId,async c=>{
    await seat(c,a);
    // Server-owned bounded native metadata check, while local seat/revision
    // locks are held. Native assignment is a fresh snapshot, not a distributed
    // transaction with the business DB; no cached client can_edit authority.
    if(options.authorizeCorrection){if(!await options.authorizeCorrection(a,e))throw Error('insights_edit_forbidden');}
    else if(a.role==='agent')throw Error('insights_assignment_verification_required');
    if(!await binding(c,e))throw Error('insights_customer_unavailable');
    const p=(await c.query('SELECT * FROM customer_insight_profiles WHERE tenant_id=$1 AND customer_id=$2 FOR UPDATE',[e.tenantId,e.customerId])).rows[0];
    if(!p||String(p.account_id)!==a.accountId||number(p.revision)!==revision)throw Error('insights_revision_conflict');
    if(p.suppressed&&change.action==='correct')throw Error('insights_correction_invalid');
    if(change.action==='correct'){
     await c.query(`UPDATE customer_insight_profiles SET manual_facts=$3,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND customer_id=$2`,[e.tenantId,e.customerId,JSON.stringify(change.facts.map(text=>({text:text.trim()})))]);
     const changed=await c.query('UPDATE customer_insight_summaries SET manual_issue=$4 WHERE tenant_id=$1 AND customer_id=$2 AND conversation_id=$3',[e.tenantId,e.customerId,e.conversationId,change.issue]);
     if(changed.rowCount!==1)throw Error('insights_summary_missing');
    }else if(change.action==='delete'){
     await c.query(`UPDATE customer_insight_profiles SET ai_facts='[]',manual_facts=NULL,suppressed=true,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND customer_id=$2`,[e.tenantId,e.customerId]);
     // An internal blank tombstone is excluded from projections/charts, not a
     // physical delete that lets an old generated job resurrect its result.
     await c.query(`UPDATE customer_insight_summaries SET ai_issue='{}',manual_issue=NULL WHERE tenant_id=$1 AND customer_id=$2`,[e.tenantId,e.customerId]);
    }else await c.query(`UPDATE customer_insight_profiles SET suppressed=false,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND customer_id=$2`,[e.tenantId,e.customerId]);
    await c.query("UPDATE customer_insight_jobs SET state='revoked',completed_at=clock_timestamp() WHERE tenant_id=$1 AND customer_id=$2 AND state='pending'",[e.tenantId,e.customerId]);
    await c.query('INSERT INTO customer_insight_audit(tenant_id,actor_id,customer_id,action,revision) VALUES($1,$2,$3,$4,$5)',[e.tenantId,a.userId,e.customerId,change.action,revision+1]);
    return {revision:revision+1};
   });
  },
  projection:async(a:InsightsActor,e:Omit<VerifiedInsightEvent,'messageId'>)=>{
   actorInput(a);eventInput({...e,messageId:'1'});if(e.tenantId!==a.tenantId||e.accountId!==a.accountId)throw Error('insights_identity_required');
   return tx(a.tenantId,async c=>{
    await seat(c,a);if(!await binding(c,e))throw Error('insights_customer_unavailable');
    const p=(await c.query(`SELECT p.revision,p.suppressed,COALESCE(p.manual_facts,p.ai_facts) facts,s.ai_issue,s.manual_issue,s.topic
     FROM customer_insight_profiles p LEFT JOIN customer_insight_summaries s ON s.tenant_id=p.tenant_id
     AND s.customer_id=p.customer_id AND s.conversation_id=$3 WHERE p.tenant_id=$1 AND p.customer_id=$2 AND p.account_id=$4`,[e.tenantId,e.customerId,e.conversationId,a.accountId])).rows[0];
    if(!p)return null;return {revision:number(p.revision),suppressed:p.suppressed,long_term:p.suppressed?[]:p.facts,
     current_issue:p.suppressed?null:typeof p.manual_issue==='string'?{text:p.manual_issue}:p.ai_issue?.text?p.ai_issue:null,
     topic:p.suppressed||!p.ai_issue?.text?null:p.topic??null};
   });
  },
  topicCounts:async(a:InsightsActor,days=7)=>{
   actorInput(a);if(!Number.isInteger(days)||days<1||days>90)throw Error('insights_rollup_limit');
   return tx(a.tenantId,async c=>{
    await seat(c,a);const rows=(await c.query(`SELECT topic,count(*)::int count FROM (
     SELECT DISTINCT ON(s.customer_id) s.customer_id,s.topic FROM customer_insight_summaries s
     JOIN customer_insight_profiles p ON p.tenant_id=s.tenant_id AND p.customer_id=s.customer_id
     JOIN customers cu ON cu.tenant_id=p.tenant_id AND cu.customer_id=p.customer_id
     WHERE s.tenant_id=$1 AND p.account_id=$2 AND NOT p.suppressed AND s.ai_issue<>'{}'::jsonb
     AND s.updated_at>=clock_timestamp()-($3::int*INTERVAL '1 day')
     ORDER BY s.customer_id,s.updated_at DESC,s.conversation_id DESC) latest GROUP BY topic`,[a.tenantId,a.accountId,days])).rows;
    const counts=new Map(rows.map(r=>[r.topic,number(r.count)])),total=rows.reduce((n,r)=>n+number(r.count),0);
    return {total,topics:INSIGHT_TOPICS.map(topic=>({topic,count:counts.get(topic)??0,percent:total?(counts.get(topic)??0)/total*100:0}))};
   });
  },
  profileCounts:async(a:InsightsActor,days=7)=>{
   actorInput(a);if(!Number.isInteger(days)||days<1||days>90)throw Error('insights_rollup_limit');
   return tx(a.tenantId,async c=>{
    await seat(c,a);
    const rows=(await c.query(`WITH recent AS (
     SELECT p.customer_id,p.ai_facts,p.manual_facts FROM customer_insight_profiles p
     JOIN customers cu ON cu.tenant_id=p.tenant_id AND cu.customer_id=p.customer_id
     WHERE p.tenant_id=$1 AND p.account_id=$2 AND NOT p.suppressed
      AND EXISTS(SELECT 1 FROM customer_insight_jobs j WHERE j.tenant_id=p.tenant_id AND j.customer_id=p.customer_id
       AND j.account_id=p.account_id AND j.state='saved' AND j.completed_at>=clock_timestamp()-($3::int*INTERVAL '1 day'))
      AND EXISTS(SELECT 1 FROM channel_identities i WHERE i.tenant_id=p.tenant_id AND i.customer_id=p.customer_id AND i.sync_status='synced')
    ), categories AS (
     SELECT DISTINCT r.customer_id,f.value->>'category' category FROM recent r
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN r.manual_facts IS NULL THEN r.ai_facts ELSE '[]'::jsonb END) f
     WHERE f.value->>'category'=ANY($4::text[])
    ) SELECT NULL::text category,count(*)::int count FROM recent
     UNION ALL SELECT '__classified',count(DISTINCT customer_id)::int FROM categories
     UNION ALL SELECT category,count(*)::int FROM categories GROUP BY category`,[a.tenantId,a.accountId,days,INSIGHT_PROFILE_CATEGORIES])).rows;
    const counts=new Map(rows.map(r=>[r.category,number(r.count)])),total=counts.get(null)??0,classified=counts.get('__classified')??0;
    return {total,classified,unclassified:total-classified,categories:INSIGHT_PROFILE_CATEGORIES.map(category=>({category,count:counts.get(category)??0,percent:total?(counts.get(category)??0)/total*100:0}))};
   });
  },
  billingRecords:async(a:InsightsActor,before?:string)=>{
   actorInput(a);if(before!==undefined&&!uuid(before))throw Error('insights_cursor_invalid');
   const points=(v:unknown)=>{const n=BigInt(String(v));if(n<0n||n>10000000000n)throw Error('insights_record_invalid');return `${n/1000000n}.${(n%1000000n).toString().padStart(6,'0')}`;};
   return tx(a.tenantId,async c=>{
    await seat(c,a,true);
    if(before&&!((await c.query('SELECT 1 FROM customer_insight_jobs WHERE tenant_id=$1 AND account_id=$2 AND job_id=$3',[a.tenantId,a.accountId,before])).rowCount))throw Error('insights_cursor_invalid');
    const rows=(await c.query(`SELECT j.job_id,j.state job_state,j.revision,
     to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at,
     b.state budget_state,b.estimated_micros,b.charged_micros budget_charged,
     u.status points_state,u.charged_micros,u.reserved_micros
     FROM customer_insight_jobs j LEFT JOIN customer_insight_budget b ON b.job_id=j.job_id AND b.tenant_id=j.tenant_id
     LEFT JOIN ai_usage_calls u ON u.call_id=b.ai_call_id AND u.tenant_id=j.tenant_id AND u.feature='copilot'
      AND u.request_key='customer-insights:'||j.job_id::text
     WHERE j.tenant_id=$1 AND j.account_id=$2 AND ($3::uuid IS NULL OR (j.created_at,j.job_id)<
      (SELECT created_at,job_id FROM customer_insight_jobs WHERE tenant_id=$1 AND account_id=$2 AND job_id=$3))
     ORDER BY j.created_at DESC,j.job_id DESC LIMIT 11`,[a.tenantId,a.accountId,before??null])).rows;
    const records=rows.slice(0,10).map(r=>({job_id:r.job_id,created_at:r.created_at,job_state:r.job_state,budget_state:r.budget_state??null,
     reserved_points:points(r.estimated_micros??0),budget_hold_points:points(['held','calling','unknown'].includes(r.budget_state)?r.estimated_micros:0),
     charged_points:r.points_state==='succeeded'?points(r.charged_micros):r.points_state==='failed'?points(0):null,
     points_state:r.points_state==='succeeded'?'charged':r.points_state==='failed'?'not_charged':r.points_state==='reserved'?'reserved':r.budget_state?'unknown':'unreserved',
     can_reconcile:['calling','unknown'].includes(r.budget_state)&&r.points_state==='succeeded'&&number(r.reserved_micros)===number(r.estimated_micros)&&number(r.charged_micros)<=number(r.estimated_micros)}));
    return {records,next_before:rows.length>10?records.at(-1)!.job_id:null};
   });
  },
  reconcileReceipt:async(a:InsightsActor,id:string)=>{
   actorInput(a);if(!uuid(id))throw Error('insights_cursor_invalid');
   return tx(a.tenantId,async c=>{
    await seat(c,a,true);
    const j=(await c.query('SELECT * FROM customer_insight_jobs WHERE tenant_id=$1 AND account_id=$2 AND job_id=$3 FOR SHARE',[a.tenantId,a.accountId,id])).rows[0];
    if(!j)throw Error('insights_customer_unavailable');
    const b=(await c.query('SELECT * FROM customer_insight_budget WHERE tenant_id=$1 AND job_id=$2 FOR UPDATE',[a.tenantId,id])).rows[0];
    if(!b)throw Error('insights_points_not_settled');
    const u=(await c.query("SELECT * FROM ai_usage_calls WHERE tenant_id=$1 AND call_id=$2 AND request_key=$3 AND feature='copilot' FOR SHARE",[a.tenantId,b.ai_call_id,`customer-insights:${id}`])).rows[0];
    if(!u||u.status!=='succeeded'||u.charged_micros===null||number(u.reserved_micros)!==number(b.estimated_micros)||number(u.charged_micros)>number(b.estimated_micros))throw Error('insights_points_not_settled');
    if(b.state==='known'){if(number(b.charged_micros)!==number(u.charged_micros))throw Error('insights_settlement_conflict');return {repeated:true};}
    if(!['calling','unknown'].includes(b.state))throw Error('insights_points_not_settled');
    // Copy only an existing immutable settled receipt, never accept amounts or
    // token counts from a tenant. No provider retry, credit refund or job revival.
    await c.query("UPDATE customer_insight_budget SET state='known',charged_micros=$2 WHERE ticket=$1",[b.ticket,number(u.charged_micros)]);
    await c.query("INSERT INTO customer_insight_audit(tenant_id,actor_id,customer_id,action,revision) VALUES($1,$2,$3,'cost_reconcile',$4)",[a.tenantId,a.userId,j.customer_id,number(j.revision)+1]);
    return {repeated:false};
   });
  },
  searchCustomerIds:async(a:InsightsActor,q:string,limit=20)=>{
   actorInput(a);if(typeof q!=='string'||q.trim().length<2||q.length>100||!Number.isInteger(limit)||limit<1||limit>100)throw Error('insights_search_invalid');
   const pattern='%'+q.trim().replace(/[\\%_]/g,'\\$&')+'%';
   return tx(a.tenantId,async c=>{
    await seat(c,a);const rows=(await c.query(`SELECT p.customer_id FROM customer_insight_profiles p
     JOIN customers cu ON cu.tenant_id=p.tenant_id AND cu.customer_id=p.customer_id
     WHERE p.tenant_id=$1 AND p.account_id=$2 AND NOT p.suppressed AND (
      p.search_text ILIKE $3 ESCAPE '\\' OR EXISTS(SELECT 1 FROM customer_insight_summaries s
       WHERE s.tenant_id=p.tenant_id AND s.customer_id=p.customer_id AND s.search_text ILIKE $3 ESCAPE '\\'))
     AND EXISTS(SELECT 1 FROM channel_identities i WHERE i.tenant_id=p.tenant_id AND i.customer_id=p.customer_id AND i.sync_status='synced')
     ORDER BY p.customer_id LIMIT $4`,[a.tenantId,a.accountId,pattern,limit])).rows;
    return rows.map(r=>r.customer_id as string);
   });
  },
  searchConversationIds:async(a:InsightsActor,q:string,ids:string[])=>{
   actorInput(a);if(typeof q!=='string'||!q.trim()||q.length>120||!Array.isArray(ids)||ids.length>100||ids.some(v=>!native(v))||new Set(ids).size!==ids.length)throw Error('insights_search_invalid');
   if(!ids.length)return [];
   const pattern='%'+q.trim().replace(/[\\%_]/g,'\\$&')+'%';
   return tx(a.tenantId,async c=>{
    await seat(c,a);
    // Only candidates on the actual bounded native page, never a global
    // customer-ID cap that silently hides older results. List cursor continues.
    const rows=(await c.query(`SELECT DISTINCT i.chatwoot_conversation_id::text AS id FROM channel_identities i
     JOIN customers cu ON cu.tenant_id=i.tenant_id AND cu.customer_id=i.customer_id
     JOIN customer_insight_profiles p ON p.tenant_id=i.tenant_id AND p.customer_id=i.customer_id
     WHERE i.tenant_id=$1 AND p.account_id=$2 AND NOT p.suppressed AND i.sync_status='synced'
      AND i.chatwoot_contact_id IS NOT NULL AND i.chatwoot_conversation_id=ANY($3::bigint[])
      AND NOT EXISTS(SELECT 1 FROM channel_identities other WHERE other.tenant_id=i.tenant_id
       AND other.chatwoot_contact_id=i.chatwoot_contact_id AND other.customer_id IS DISTINCT FROM i.customer_id)
      AND (p.search_text ILIKE $4 ESCAPE '\\' OR EXISTS(SELECT 1 FROM customer_insight_summaries s
       WHERE s.tenant_id=p.tenant_id AND s.customer_id=p.customer_id AND s.search_text ILIKE $4 ESCAPE '\\'))
     ORDER BY id LIMIT 100`,[a.tenantId,a.accountId,ids,pattern])).rows;
    return rows.map(r=>r.id as string);
   });
  },
  recoverStale:async(id:string)=>tx(id,async c=>{
   const rows=(await c.query(`SELECT * FROM customer_insight_jobs WHERE tenant_id=$1 AND state IN('leased','calling')
    AND lease_until<=clock_timestamp() ORDER BY lease_until,job_id LIMIT 20 FOR UPDATE`,[id])).rows;
   for(const r of rows){
    const b=(await c.query('SELECT * FROM customer_insight_budget WHERE tenant_id=$1 AND job_id=$2 FOR UPDATE',[id,r.job_id])).rows[0];
    // A durable calling record or linked ledger receipt is conservatively held.
    // Never put a potentially charged job back in pending after a worker crash.
    const uncertain=r.state==='calling'||b&&['calling','unknown'].includes(b.state)||b?.state==='held'&&b.ai_call_id;
    if(b&&['held','calling'].includes(b.state))await c.query('UPDATE customer_insight_budget SET state=$2 WHERE ticket=$1',[b.ticket,uncertain?'unknown':'not_called']);
    await c.query('UPDATE customer_insight_jobs SET state=$2,completed_at=clock_timestamp() WHERE job_id=$1',[r.job_id,uncertain?'uncertain':'revoked']);
   }
   return rows.length;
  })
 };
}
