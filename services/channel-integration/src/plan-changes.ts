import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {walletTransaction,walletFunds,walletRequestKey,walletAudit} from './wallet.js';
import {WalletError,allocatePayment,takeGifts} from './wallet-core.js';
import {validateEntitlements} from './subscription-core.js';
import {quotePlanChange,type PlanValue} from './plan-change-core.js';
import {postLedgerInTransaction} from './ledger.js';
import {capturePlanCommission} from './plan-commissions.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function basis(c:PoolClient,tenant:string,target:string){
 if(!uuid.test(target))throw new WalletError('invalid_request',400);
 if((await c.query(`SELECT 1 FROM wallet_requests WHERE tenant_id=$1 AND kind='plan_refund' AND status IN ('requested','approved') UNION ALL SELECT 1 FROM payment_refund_requests WHERE tenant_id=$1 AND status NOT IN ('succeeded','rejected')`,[tenant])).rowCount)throw new WalletError('refund_in_progress');
 if((await c.query(`SELECT 1 FROM plan_payment_purchases p JOIN payment_orders o USING(payment_order_id) WHERE p.tenant_id=$1 AND ((o.status='pending_payment' AND p.expires_at>NOW()) OR (o.status='paid' AND p.status<>'fulfilled'))`,[tenant])).rowCount)throw new WalletError('checkout_in_progress');
 const current=(await c.query(`SELECT s.*,p.plan_code,NOW() AS checked_at FROM tenant_subscriptions s JOIN plan_catalog_versions p USING(plan_version_id) WHERE tenant_id=$1 AND s.status='active' AND s.current_period_end>NOW() FOR UPDATE OF s`,[tenant])).rows[0];
 if(!current||current.source!=='payment'||current.provider!=='wallet'||!['starter','professional'].includes(current.plan_code))throw new WalletError('plan_change_requires_review');
 const plan=(await c.query(`SELECT * FROM plan_catalog_versions WHERE plan_version_id=$1 AND status='active' AND effective_from<=NOW() AND (effective_until IS NULL OR effective_until>NOW()) FOR SHARE`,[target])).rows[0];
 if(!plan||!['starter','professional'].includes(plan.plan_code)||plan.currency!=='CNY'||plan.billing_period!=='monthly'||Number(plan.price_minor)<1)throw new WalletError('plan_unavailable');
 if(plan.plan_code===current.plan_code)throw new WalletError('same_plan_use_renewal');
 const prior=(await c.query(`SELECT subscription_event_id,facts FROM subscription_events WHERE tenant_id=$1 AND subscription_id=$2 AND source='wallet_plan_change' ORDER BY created_at DESC,subscription_event_id DESC LIMIT 1`,[tenant,current.subscription_id])).rows[0];
 const values:PlanValue[]=prior?.facts?.values??[];
 const purchases=(await c.query(`SELECT p.* FROM wallet_purchases p WHERE p.tenant_id=$1 AND p.subscription_id=$2 AND NOT EXISTS(SELECT 1 FROM wallet_requests r WHERE r.purchase_id=p.purchase_id AND r.status='paid') ORDER BY p.period_start,p.purchase_id LIMIT 97`,[tenant,current.subscription_id])).rows;
 if(purchases.length>96||!Array.isArray(values))throw new WalletError('plan_value_requires_review');
 const ids=new Set(values.map(v=>v.purchase_id));
 for(const p of purchases)if(!ids.has(p.purchase_id))values.push({purchase_id:p.purchase_id,paid_at:p.created_at.toISOString(),original_minor:Number(p.amount_minor),value_minor:Number(p.amount_minor),cash_minor:Number(p.cash_minor),gift_minor:Number(p.gift_minor),gift_allocations:p.gift_allocations,starts:p.period_start.toISOString(),ends:p.period_end.toISOString()});
 if(!values.length||values.length>96)throw new WalletError('plan_value_requires_review');
 const at=current.checked_at.toISOString();
 const active=purchases.find(p=>+p.period_start<=+current.checked_at&&+p.period_end>+current.checked_at);
 // A converted term may later be renewed with a different payment period.
 // Once that renewal starts, its period wins over the historical change receipt.
 const period=active?.billing_period??prior?.facts?.billing_period;
 if(!['monthly','annual'].includes(period))throw new WalletError('plan_value_requires_review');
 const term=(await c.query(`SELECT (($1::timestamptz AT TIME ZONE 'Asia/Shanghai')+$2::int*INTERVAL '1 month') AT TIME ZONE 'Asia/Shanghai' AS ends`,[at,period==='annual'?12:1])).rows[0].ends.toISOString();
 const direction=current.plan_code==='starter'?'upgrade':'downgrade';
 const quote=quotePlanChange(values,at,current.current_period_end.toISOString(),term,Number(plan.price_minor)*(period==='annual'?8:1),direction);
 const state={subscription_id:current.subscription_id,period_end:current.current_period_end.toISOString(),plan_version_id:plan.plan_version_id,monthly_price_minor:String(plan.price_minor),entitlement_snapshot:plan.entitlement_rules,values};
 return {current,plan,period,quote,state};
}
export async function quoteWalletPlanChange(tenant:string,actor:string,raw:any,requestId:string){
 const key=walletRequestKey(raw);
 return walletTransaction(tenant,async c=>{
  const replay=(await c.query(`SELECT * FROM subscription_events WHERE tenant_id=$1 AND event_key=$2`,[tenant,'plan-quote:'+key])).rows[0];
  if(replay){if(replay.facts.target_plan_version_id!==raw.plan_version_id)throw new WalletError('idempotency_conflict');return {...replay.facts,quote_id:replay.subscription_event_id};}
  const b=await basis(c,tenant,raw.plan_version_id),f=await walletFunds(c,tenant);
  const payment=b.quote.due_minor?{gift_minor:Math.min(b.quote.due_minor,f.gift_minor),cash_minor:Math.max(0,b.quote.due_minor-f.gift_minor)}:{gift_minor:0,cash_minor:0};
  const expires=new Date(Math.min(+b.current.checked_at+5*60000,+b.current.current_period_end)).toISOString();
  const facts={...b.quote,billing_period:b.period,plan_name:b.plan.name,target_plan_version_id:b.plan.plan_version_id,current_subscription_id:b.current.subscription_id,state_digest:digest(b.state),expires_at:expires,payment,available_cash_minor:f.available_cash_minor};
  const event=(await c.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,event_key,facts) VALUES($1,$2,'created','wallet_plan_quote',$3,$4) RETURNING subscription_event_id`,[tenant,b.current.subscription_id,'plan-quote:'+key,JSON.stringify(facts)])).rows[0];
  await walletAudit(c,tenant,actor,'wallet.plan_change_quoted',event.subscription_event_id,requestId);
  return {...facts,quote_id:event.subscription_event_id};
 });
}
export async function executeWalletPlanChange(tenant:string,actor:string,raw:any,requestId:string){
 const key=walletRequestKey(raw);if(!uuid.test(raw.quote_id??'')||raw.accepted!==true)throw new WalletError('invalid_request',400);
 return walletTransaction(tenant,async c=>{
  const replay=(await c.query(`SELECT subscription_event_id,facts FROM subscription_events WHERE tenant_id=$1 AND event_key=$2`,[tenant,'plan-change:'+key])).rows[0];
  if(replay){if(replay.facts.quote_id!==raw.quote_id)throw new WalletError('idempotency_conflict');return {...replay.facts,change_id:replay.subscription_event_id};}
  const event=(await c.query(`SELECT * FROM subscription_events WHERE tenant_id=$1 AND subscription_event_id=$2 AND source='wallet_plan_quote'`,[tenant,raw.quote_id])).rows[0];
  if(!event)throw new WalletError('plan_quote_not_found',404);
  if((await c.query(`SELECT 1 FROM subscription_events WHERE tenant_id=$1 AND source='wallet_plan_change' AND facts->>'quote_id'=$2`,[tenant,raw.quote_id])).rowCount)throw new WalletError('plan_quote_used');
  const q=event.facts,b=await basis(c,tenant,q.target_plan_version_id);
  if(+b.current.checked_at>=+new Date(q.expires_at))throw new WalletError('plan_quote_expired');
  if(digest(b.state)!==q.state_digest)throw new WalletError('plan_quote_changed');
  const f=await walletFunds(c,tenant),payment=q.due_minor?allocatePayment(q.due_minor,f.gift_minor,f.available_cash_minor):{gift_minor:0,cash_minor:0},gifts=takeGifts(f.lots,payment.gift_minor);
  if(payment.cash_minor!==q.payment.cash_minor||payment.gift_minor!==q.payment.gift_minor)throw new WalletError('plan_quote_changed');
  // Confirmed quotes fix amounts and time; no new allowance or mutable bill rewrite.
  const snapshot={...validateEntitlements(b.plan.entitlement_rules),ai_cycle_anchor:b.current.entitlement_snapshot.ai_cycle_anchor??b.current.current_period_start.toISOString()};
  await c.query(`UPDATE tenant_subscriptions SET status='canceled',updated_at=NOW() WHERE subscription_id=$1`,[b.current.subscription_id]);
  const subscription=(await c.query(`INSERT INTO tenant_subscriptions(tenant_id,plan_version_id,status,source,provider,current_period_start,current_period_end,price_minor_snapshot,currency_snapshot,entitlement_snapshot) VALUES($1,$2,'active','payment','wallet',NOW(),$3,$4,'CNY',$5) RETURNING subscription_id`,[tenant,b.plan.plan_version_id,q.period_end,Number(b.plan.price_minor)*(b.period==='annual'?8:1),JSON.stringify(snapshot)])).rows[0].subscription_id;
  const values:PlanValue[]=q.values;
  let purchase:any=null;
  if(q.due_minor){
   purchase=(await c.query(`INSERT INTO wallet_purchases(tenant_id,idempotency_key,plan_version_id,plan_name,billing_period,amount_minor,gift_minor,cash_minor,gift_allocations,entitlement_snapshot,subscription_id,period_start,period_end,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[tenant,'change:'+key,b.plan.plan_version_id,b.plan.name,b.period,q.due_minor,payment.gift_minor,payment.cash_minor,JSON.stringify(gifts),JSON.stringify(validateEntitlements(b.plan.entitlement_rules)),subscription,q.valuation_at,q.period_end,actor])).rows[0];
   await postLedgerInTransaction(c,tenant,{transaction_type:'charge',currency:'CNY',idempotency_key:'wallet-purchase:'+purchase.purchase_id,source_type:'wallet_purchase',source_id:purchase.purchase_id,occurred_at:purchase.created_at.toISOString(),metadata:{gift_allocations:gifts,plan_change_quote_id:event.subscription_event_id},entries:[...(payment.gift_minor?[{account:'gift',direction:'debit',amount_minor:payment.gift_minor}]:[]),...(payment.cash_minor?[{account:'cash',direction:'debit',amount_minor:payment.cash_minor}]:[]),{account:'revenue',direction:'credit',amount_minor:q.due_minor}]},{actor_id:actor,request_id:requestId});
   await capturePlanCommission(c,purchase);
   values.push({purchase_id:purchase.purchase_id,paid_at:purchase.created_at.toISOString(),original_minor:q.due_minor,value_minor:q.due_minor,...payment,gift_allocations:gifts,starts:q.valuation_at,ends:q.period_end});
  }
  const facts={version:1,direction:q.direction,quote_id:raw.quote_id,subscription_id:subscription,previous_subscription_id:b.current.subscription_id,plan_name:b.plan.name,plan_version_id:b.plan.plan_version_id,billing_period:b.period,valuation_at:q.valuation_at,period_end:q.period_end,carry_minor:q.carry_minor,due_minor:q.due_minor,payment,values,refund_purchase_id:purchase?.purchase_id??values[0].purchase_id};
  const changed=(await c.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,event_key,facts) VALUES($1,$2,'plan_changed','wallet_plan_change',$3,$4) RETURNING subscription_event_id`,[tenant,subscription,'plan-change:'+key,JSON.stringify(facts)])).rows[0];
  await walletAudit(c,tenant,actor,'wallet.plan_changed',changed.subscription_event_id,requestId);
  return {...facts,change_id:changed.subscription_event_id};
 });
}
