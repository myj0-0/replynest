import {pool} from './database.js';
export {balances as aiPointBalances};
import type {Pool,PoolClient} from 'pg';
import {aiUsageEntitlement} from './subscriptions.js';
import {POINT_NANO_CNY,priceAiUsage,initialAiPrices,type AiUsage} from './ai-points-core.js';
export const aiPointsEnabled=()=>process.env.AI_POINTS_ENABLED==='true';
export class AiPointsError extends Error{constructor(public code:string){super(code);}}
type Feature='copilot'|'studio'|'embedding_query'|'embedding_document';
// Balance/reservation/settlement must not occupy a connection indefinitely when
// another writer owns a tenant wallet lock. Provider I/O never runs here.
async function transaction<T>(tenant:string,fn:(c:PoolClient)=>Promise<T>,db:Pick<Pool,'connect'>=pool){const c=await db.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s';SET LOCAL lock_timeout='500ms'");await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`wallet:${tenant}`]);await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`ai-points:${tenant}`]);const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function balances(c:PoolClient,tenant:string){
 const overview=await aiUsageEntitlement(tenant,c),period=overview.usage.period_start;
 // Preserve legacy recorded usage without rewriting existing subscription snapshots.
 const legacy=Number(overview.usage.ai_actions_monthly)*10*POINT_NANO_CNY;
 const limit=overview.entitlements.ai_actions_monthly===null?null:overview.entitlements.ai_actions_monthly*10*POINT_NANO_CNY;
 // Durable insight calls have a calling fence and explicit cost reconciliation.
 // Their unknown cost must not become an immutable abandoned/free call at 15m.
 // Exact server-generated UUID keys only; all existing generic behavior remains.
 await c.query(`UPDATE ai_usage_calls SET status='abandoned',completed_at=NOW(),error_code='reservation_expired_cost_unknown' WHERE tenant_id=$1 AND status='reserved' AND created_at<NOW()-INTERVAL '15 minutes'
  AND request_key !~ '^customer-insights:[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'`,[tenant]);
 // Keep the fast projection for this cycle. Bridge immutable calls written with
 // an older calendar-month key (or a different plan key) only within this cycle.
 // Indexed tenant/period range bounds the compatibility read to at most 62 days;
 // no historical bills are rewritten, and held usage remains unavailable.
 const usage=(await c.query(`SELECT (
  COALESCE((SELECT used_micros FROM ai_point_month_usage WHERE tenant_id=$1 AND period_start=$2),0)+
  COALESCE((SELECT SUM(CASE WHEN status='reserved' THEN monthly_reserved_micros ELSE monthly_charged_micros END)
   FROM ai_usage_calls WHERE tenant_id=$1 AND period_start>=$2::timestamptz-INTERVAL '31 days'
    AND period_start<$3 AND period_start<>$2 AND created_at>=$2 AND created_at<$3),0)
 )::text AS used`,[tenant,period,overview.usage.period_end])).rows[0]??{used:'0'};
 const funding=(await c.query(`SELECT entry_id,remaining_minor::text,expires_at FROM ai_point_funding_lots
  WHERE tenant_id=$1 AND remaining_minor>0 AND (expires_at IS NULL OR expires_at>NOW())
  ORDER BY expires_at NULLS LAST,posted_at,transaction_id,entry_id`,[tenant])).rows;
 // Existing AIC minor units convert to micro-points, without changing original lot identity/expiry.
 const lots=funding.map(l=>({entry_id:l.entry_id as string,amount_minor:Number(l.remaining_minor)*10000,expires_at:l.expires_at?new Date(l.expires_at).toISOString():null}));
 // Monitoring denominator: unexpired grants, net of ledger reversals and held/approved refunds.
 // Keep the grant face value before AI consumption; never derive a percentage from remaining alone.
 const capacity=new Map(lots.map(l=>[l.entry_id,l.amount_minor]));
 const used=(await c.query(`SELECT entry_id,used_micros::text AS used FROM ai_point_lot_usage WHERE tenant_id=$1 AND entry_id=ANY($2::uuid[])`,[tenant,lots.map(l=>l.entry_id)])).rows;
 const lotUsage=new Map(used.map(row=>[row.entry_id,Number(row.used)]));
 for(const lot of lots){const debit=lotUsage.get(lot.entry_id)??0;if(!Number.isSafeInteger(debit)||debit<0)throw new AiPointsError('ai_balance_requires_review');lot.amount_minor=Math.max(0,lot.amount_minor-debit);}
 const refunds=(await c.query(`SELECT entry_id,held_micros::text AS point_micros FROM ai_point_refund_usage WHERE tenant_id=$1 AND entry_id=ANY($2::uuid[]) AND held_micros>0`,[tenant,lots.map(l=>l.entry_id)])).rows;
 for(const r of refunds){const lot=lots.find(l=>l.entry_id===r.entry_id);if(lot)lot.amount_minor=Math.max(0,lot.amount_minor-Number(r.point_micros));if(capacity.has(r.entry_id))capacity.set(r.entry_id,Math.max(0,capacity.get(r.entry_id)!-Number(r.point_micros)));}
 const monthlyUsed=legacy+Number(usage.used),credit=lots.reduce((n,l)=>n+l.amount_minor,0);
 for(const n of [legacy,monthlyUsed,credit,...lots.map(l=>l.amount_minor)])if(!Number.isSafeInteger(n)||n<0)throw new AiPointsError('ai_balance_requires_review');
 const creditLimit=[...capacity.values()].reduce((n,v)=>n+v,0);
 if(!Number.isSafeInteger(creditLimit)||creditLimit<0)throw new AiPointsError('ai_balance_requires_review');
 return {period,period_end:overview.usage.period_end,period_policy:overview.usage.period_policy,monthly_limit_micros:limit,monthly_used_micros:monthlyUsed,monthly_available_micros:limit===null?null:Math.max(0,limit-monthlyUsed),credit_available_micros:credit,credit_limit_micros:creditLimit,lots};
}
export async function aiPointsOverview(tenant:string,db:Pick<Pool,'connect'>=pool){return transaction(tenant,async c=>{const {lots,period,...b}=await balances(c,tenant);const pack=(await c.query(`SELECT pack_version_id,version,points::text,price_minor::text FROM ai_point_pack_versions WHERE status='active'`)).rows[0];return {...b,period_start:period,unit:'AI 点数',enabled:aiPointsEnabled(),legacy_conversion:'1 AIC = 1 point; 1 legacy monthly action = 10 monthly points',pack};},db);}
export async function reserveAiPoints(tenant:string,key:string,feature:Feature,inputTokenBound:number,outputBound:number,db:Pick<Pool,'connect'>=pool){
 const price=initialAiPrices[feature.startsWith('embedding')?'embedding':'text'];
 const reserve=priceAiUsage({input_tokens:inputTokenBound,output_tokens:outputBound,cached_input_tokens:0},price).point_micros;
 return transaction(tenant,async c=>{
 if((await c.query('SELECT 1 FROM ai_usage_calls WHERE tenant_id=$1 AND request_key=$2',[tenant,key])).rowCount)throw new AiPointsError('ai_request_already_reserved');
 const b=await balances(c,tenant),monthly=Math.min(reserve,b.monthly_available_micros??reserve);let rest=reserve-monthly;
 if(rest>b.credit_available_micros)throw new AiPointsError('ai_points_insufficient');
 const allocations=[];for(const l of b.lots){const amount=Math.min(rest,l.amount_minor);if(amount)allocations.push({...l,amount_minor:amount});rest-=amount;if(!rest)break;}
 return (await c.query(`INSERT INTO ai_usage_calls(tenant_id,request_key,feature,model,price_snapshot,period_start,reserved_micros,monthly_reserved_micros,credit_allocations) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING call_id`,[tenant,key,feature,price.model,JSON.stringify(price),b.period,reserve,monthly,JSON.stringify(allocations)])).rows[0].call_id as string;
 },db);
}
export async function settleAiPoints(tenant:string,callId:string,usage:AiUsage|undefined,succeeded:boolean,errorCode?:string,db:Pick<Pool,'connect'>=pool){return transaction(tenant,async c=>{
 const r=(await c.query('SELECT * FROM ai_usage_calls WHERE tenant_id=$1 AND call_id=$2 FOR UPDATE',[tenant,callId])).rows[0];if(!r)throw new AiPointsError('ai_request_not_found');if(r.status!=='reserved')return;
 const cost=usage?priceAiUsage(usage,r.price_snapshot).cost_nano_cny:null;
 // Unexpected overrun is absorbed by the platform, never silently exceeds the disclosed hold.
 const charged=succeeded&&cost!==null?Math.min(cost,Number(r.reserved_micros)):0;
 await c.query(`UPDATE ai_usage_calls SET status=$3,monthly_charged_micros=$4,charged_micros=$5,cost_nano_cny=$6,input_tokens=$7,output_tokens=$8,cached_input_tokens=$9,error_code=$10,completed_at=clock_timestamp() WHERE call_id=$1 AND tenant_id=$2`,[callId,tenant,succeeded?'succeeded':'failed',Math.min(charged,Number(r.monthly_reserved_micros)),charged,cost,usage?.input_tokens??null,usage?.output_tokens??null,usage?.cached_input_tokens??null,cost!==null&&cost>Number(r.reserved_micros)?'provider_usage_exceeded_reservation':errorCode??null]);
 },db);}
