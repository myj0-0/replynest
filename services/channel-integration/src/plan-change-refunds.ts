import type {PoolClient} from 'pg';
import {WalletError} from './wallet-core.js';
import {quoteChangedPlanRefund} from './plan-change-core.js';
/** Immutable value-chain receipt, never a fresh refund window after switching. */
export async function changedPlanRefund(c:PoolClient,tenant:string,id:string){
 const e=(await c.query(`SELECT e.*,s.status AS subscription_status,s.current_period_end,NOW() AS checked_at FROM subscription_events e JOIN tenant_subscriptions s ON s.subscription_id=e.subscription_id AND s.tenant_id=e.tenant_id WHERE e.tenant_id=$1 AND e.subscription_event_id=$2 AND e.source='wallet_plan_change' FOR UPDATE OF s`,[tenant,id])).rows[0];
 if(!e)throw new WalletError('purchase_not_found',404);
 if(e.subscription_status!=='active'||+e.current_period_end!==+new Date(e.facts.period_end))throw new WalletError('refund_term_requires_review');
 return {event:e,quote:{...quoteChangedPlanRefund(e.facts.values,e.checked_at.toISOString()),change_event_id:id,subscription_id:e.subscription_id,period_end:e.facts.period_end}};
}
export async function changedPlanHistory(c:PoolClient,tenant:string){
 const rows=(await c.query(`SELECT e.subscription_event_id,e.facts,e.created_at,s.status,s.current_period_end,r.status AS refund_status,NOW() AS checked_at FROM subscription_events e JOIN tenant_subscriptions s ON s.subscription_id=e.subscription_id AND s.tenant_id=e.tenant_id LEFT JOIN wallet_requests r ON r.tenant_id=e.tenant_id AND r.quote->>'change_event_id'=e.subscription_event_id::text AND r.status<>'rejected' WHERE e.tenant_id=$1 AND e.source='wallet_plan_change' ORDER BY e.created_at DESC,e.subscription_event_id DESC LIMIT 50`,[tenant])).rows;
 return rows.map(e=>{
  let preview=null,reason=null;
  try{if(e.refund_status||e.status!=='active'||+e.current_period_end!==+new Date(e.facts.period_end))throw new WalletError('refund_term_requires_review');preview=quoteChangedPlanRefund(e.facts.values,e.checked_at.toISOString());}catch(error){reason=error instanceof WalletError?error.code:'refund_term_requires_review';}
  return {change_event_id:e.subscription_event_id,purchase_id:e.facts.refund_purchase_id,plan_name:e.facts.plan_name,direction:e.facts.direction,billing_period:e.facts.billing_period,amount_minor:e.facts.carry_minor+e.facts.due_minor,cash_minor:e.facts.values.reduce((n:number,v:any)=>n+v.cash_minor,0),gift_minor:e.facts.values.reduce((n:number,v:any)=>n+v.gift_minor,0),carry_minor:e.facts.carry_minor,due_minor:e.facts.due_minor,created_at:e.created_at,period_end:e.facts.period_end,refund_status:e.refund_status,can_refund:!!preview,refund_preview:preview,refund_unavailable_reason:reason};
 });
}
