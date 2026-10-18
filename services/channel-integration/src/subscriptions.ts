import type{PoolClient}from"pg";import{pool}from"./database.js";import{trialEntitlements,validateEntitlements,type EntitlementRules}from"./subscription-core.js";
import {aiPointPeriod} from './ai-point-period.js';
type Queryable=Pick<PoolClient,"query">;
export class EntitlementLimitError extends Error{constructor(public metric:string,public limit:number,public used:number){super(`${metric} limit exceeded`)}}
async function basePlan(db:Queryable,tenantId:string){const result=await db.query(`SELECT s.subscription_id,s.status,s.source,s.current_period_start,s.current_period_end,p.plan_code,p.name,p.version,s.entitlement_snapshot FROM tenant_subscriptions s JOIN plan_catalog_versions p ON p.plan_version_id=s.plan_version_id WHERE s.tenant_id=$1 AND s.status IN ('active','trialing','past_due') AND (s.current_period_end IS NULL OR s.current_period_end>NOW()) ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trialing' THEN 1 ELSE 2 END,s.created_at DESC LIMIT 1`,[tenantId]);if(result.rows[0])return result.rows[0];const free=await db.query(`SELECT NULL::uuid AS subscription_id,'active'::text AS status,'catalog_fallback'::text AS source,NULL::timestamptz AS current_period_start,NULL::timestamptz AS current_period_end,plan_code,name,version,entitlement_rules AS entitlement_snapshot FROM plan_catalog_versions WHERE plan_code='free' AND status='active' ORDER BY version DESC LIMIT 1`);if(!free.rows[0])throw new Error("free plan unavailable");return free.rows[0]}
export async function effectiveEntitlement(tenantId:string,db:Queryable=pool){
 const base=await basePlan(db,tenantId),baseRules=validateEntitlements(base.entitlement_snapshot);
 const trial=await db.query(`SELECT entitlement_id,starts_at,ends_at,grace_ends_at,benefit_snapshot FROM trial_entitlements WHERE tenant_id=$1 AND status='active' AND grace_ends_at>NOW() ORDER BY created_at DESC LIMIT 1`,[tenantId]);
 if(!trial.rows[0])return{subscription:base,plan:{code:base.plan_code,name:base.name,version:base.version},source:base.source,entitlements:baseRules};
 const benefit=trial.rows[0].benefit_snapshot,code=benefit.plan_code==='starter'?'starter':'professional';
 const plan=(await db.query(`SELECT name,version,entitlement_rules FROM plan_catalog_versions WHERE plan_code=$1 AND status='active' ORDER BY version DESC LIMIT 1`,[code])).rows[0];
 const rules=benefit.entitlement_snapshot?validateEntitlements(benefit.entitlement_snapshot):trialEntitlements(benefit,validateEntitlements(plan.entitlement_rules));
 return{subscription:{...base,entitlement_snapshot:rules,current_period_start:trial.rows[0].starts_at,trial_entitlement_id:trial.rows[0].entitlement_id,current_period_end:trial.rows[0].ends_at,grace_ends_at:trial.rows[0].grace_ends_at},plan:{code,name:`${benefit.plan_name??plan.name}试用`,version:benefit.plan_version??plan.version},source:'trial',entitlements:rules};
}
export async function catalog(){const result=await pool.query(`SELECT plan_version_id,plan_code,name,version,billing_period,price_minor,list_price_minor,(price_minor*8)::text AS annual_price_minor,currency,entitlement_rules,effective_from FROM plan_catalog_versions WHERE status='active' ORDER BY CASE plan_code WHEN 'free' THEN 0 WHEN 'starter' THEN 1 WHEN 'professional' THEN 2 ELSE 3 END`);return result.rows.map(row=>({...row,entitlement_rules:validateEntitlements(row.entitlement_rules)}))}
// AI billing must not count customers, seats or knowledge bytes for every model call.
export async function aiUsageEntitlement(tenantId:string,db:Queryable=pool){
 const entitlement=await effectiveEntitlement(tenantId,db);
 const period=await aiPointPeriod(db,tenantId,entitlement);
 const result=await db.query(`SELECT
  (SELECT COALESCE(SUM(units),0)::bigint FROM usage_events u WHERE u.tenant_id=t.tenant_id AND u.metric='ai_actions'
   AND u.occurred_at>=$2 AND u.occurred_at<$3) AS ai_actions_monthly
  FROM tenants t WHERE t.tenant_id=$1`,[tenantId,period.period_start,period.period_end]);
 if(!result.rows[0])throw new Error('tenant not found');return {...entitlement,usage:{...result.rows[0],...period}};
}
export async function usageOverview(tenantId:string,db:Queryable=pool){
 const overview=await aiUsageEntitlement(tenantId,db);
 const result=await db.query(`SELECT
 (SELECT COUNT(*)::int FROM tenant_memberships WHERE tenant_id=$1 AND status='active') AS active_seats,
 (SELECT COUNT(*)::int FROM channel_connections WHERE tenant_id=$1 AND status='ready' AND COALESCE(configuration->>'mode','')<>'synthetic') AS channels,
 (SELECT COUNT(*)::int FROM customers WHERE tenant_id=$1) AS customers,
 (SELECT COALESCE(SUM(file_size),0)::bigint FROM knowledge_documents WHERE tenant_id=$1 AND status<>'deleted') AS knowledge_bytes`,[tenantId]);
 return {...overview,usage:{...overview.usage,...result.rows[0]}};
}
export async function assertCapacity(tenantId:string,metric:keyof EntitlementRules,used:number,requested=1,db:Queryable=pool){const value=(await effectiveEntitlement(tenantId,db)).entitlements[metric];if(typeof value!=="number"&&value!==null)throw new Error("metric is not a limit");if(value!==null&&used+requested>value)throw new EntitlementLimitError(metric,value,used)}
export async function reserveUsage(tenantId:string,metric:"ai_actions",units:number,idempotencyKey:string,sourceType:string,sourceId:string){if(!Number.isSafeInteger(units)||units<1)throw new Error("invalid usage units");const client=await pool.connect();try{await client.query("BEGIN");await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`usage:${tenantId}:${metric}`]);const existing=await client.query(`SELECT usage_event_id FROM usage_events WHERE tenant_id=$1 AND metric=$2 AND idempotency_key=$3`,[tenantId,metric,idempotencyKey]);if(existing.rows[0]){await client.query("COMMIT");return{duplicate:true}}const overview=await usageOverview(tenantId,client);const used=Number(overview.usage.ai_actions_monthly);await assertCapacity(tenantId,"ai_actions_monthly",used,units,client);await client.query(`INSERT INTO usage_events(tenant_id,metric,units,idempotency_key,source_type,source_id) VALUES($1,$2,$3,$4,$5,$6)`,[tenantId,metric,units,idempotencyKey,sourceType,sourceId]);await client.query("COMMIT");return{duplicate:false,used:used+units,limit:overview.entitlements.ai_actions_monthly}}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}}
