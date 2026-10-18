import { randomUUID, createHash } from 'node:crypto';
import {capturePlanCommission,reducePlanCommission} from './plan-commissions.js';
export {tx as walletTransaction,funds as walletFunds,key as walletRequestKey,audit as walletAudit};
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { pool } from './database.js';
import { postLedgerInTransaction } from './ledger.js';
import { alipayConfigFromEnv, buildAlipayCheckout } from './alipay-provider.js';
import { checkoutEnabled } from './plan-checkout.js';
import { quoteRefund } from './refund-policy.js';
import {planRefundEligibility} from './plan-refund-eligibility.js';
import {changedPlanRefund,changedPlanHistory} from './plan-change-refunds.js';
import {refundAiCycleAnchor} from './ai-refund-cycle.js';
import { validateEntitlements } from './subscription-core.js';
import { WalletError, allocatePayment, feeQuote, giftLots, parseYuan, splitRefund, takeGifts } from './wallet-core.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function key(raw:any){if(typeof raw?.idempotency_key!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(raw.idempotency_key))throw new WalletError('invalid_request',400);return raw.idempotency_key;}
async function tx<T>(tenant:string,fn:(c:PoolClient)=>Promise<T>){const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`subscription-change:${tenant}`]);await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`wallet:${tenant}`]);const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function audit(c:PoolClient,tenant:string,actor:string,action:string,id:string,requestId:string){await c.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,request_id) VALUES($1,'internal_service',$2,$3,'wallet',$4,$5)`,[tenant,actor,action,id,requestId]);}
async function funds(c:PoolClient,tenant:string){
 const rows=(await c.query(`SELECT e.account,SUM(CASE WHEN e.direction='credit' THEN e.amount_minor ELSE -e.amount_minor END)::text AS amount FROM ledger_entries e JOIN ledger_transactions t USING(transaction_id) WHERE e.tenant_id=$1 AND e.currency='CNY' AND t.status='posted' GROUP BY e.account`,[tenant])).rows;
 const values=Object.fromEntries(rows.map(r=>[r.account,Number(r.amount)]));
 const entries=(await c.query(`SELECT e.*,t.posted_at,t.transaction_type,t.metadata,t.reversal_of FROM ledger_entries e JOIN ledger_transactions t USING(transaction_id) WHERE e.tenant_id=$1 AND e.currency='CNY' AND e.account='gift' AND t.status='posted' ORDER BY t.posted_at,t.transaction_id,e.created_at,e.entry_id`,[tenant])).rows;
 const lots=giftLots(entries,new Date());
 const referralEntries=(await c.query(`SELECT e.*,t.posted_at,t.transaction_type,t.metadata,t.reversal_of FROM ledger_entries e JOIN ledger_transactions t USING(transaction_id) WHERE e.tenant_id=$1 AND e.currency='CNY' AND e.account='referral' AND t.status='posted' ORDER BY t.posted_at,t.transaction_id,e.created_at,e.entry_id`,[tenant])).rows;
 // A late reversal after withdrawal creates referral debt, not a broken billing page.
 // Subsequent referral credits first repay that debt; gifts and cash remain separate.
 const referralAvailable=Math.max(0,Math.min(values.referral??0,giftLots(referralEntries,new Date(),true).reduce((n,l)=>n+l.amount_minor,0)));
 const frozen=(await c.query(`SELECT kind,SUM(amount_minor)::text AS amount FROM wallet_requests WHERE tenant_id=$1 AND status IN ('requested','approved') AND kind<>'plan_refund' GROUP BY kind`,[tenant])).rows;
 const held=Object.fromEntries(frozen.map(r=>[r.kind,Number(r.amount)]));
 for(const n of [...Object.values(values),...Object.values(held)])if(!Number.isSafeInteger(n))throw new WalletError('balance_requires_review');
 return {cash_minor:values.cash??0,gift_minor:lots.reduce((n,l)=>n+l.amount_minor,0),referral_minor:referralAvailable,ai_credit_minor:values.ai_credit??0,
   frozen_cash_minor:held.cash_refund??0,frozen_referral_minor:held.referral_withdrawal??0,
   available_cash_minor:Math.max(0,(values.cash??0)-(held.cash_refund??0)),available_referral_minor:Math.max(0,referralAvailable-(held.referral_withdrawal??0)),lots};
}
export async function walletOverview(tenant:string,view:'full'|'summary'|'purchases'|'requests'='full'){return tx(tenant,async c=>{
 const {lots,...balances}=await funds(c,tenant);
 const purchases=view==='full'||view==='purchases'?(await c.query(`SELECT p.*,r.status AS refund_status,s.status AS subscription_status,s.current_period_end AS subscription_period_end,NOW() AS checked_at FROM wallet_purchases p LEFT JOIN wallet_requests r ON r.purchase_id=p.purchase_id AND r.status<>'rejected' LEFT JOIN tenant_subscriptions s ON s.subscription_id=p.subscription_id AND s.tenant_id=p.tenant_id WHERE p.tenant_id=$1 ORDER BY p.created_at DESC,p.purchase_id DESC LIMIT 50`,[tenant])).rows.map(({checked_at,...p})=>({...p,...planRefundEligibility(p,new Date(checked_at))})):[];
 const requests=view==='full'||view==='requests'?(await c.query(`SELECT request_id,kind,purchase_id,amount_minor,fee_minor,net_minor,quote,reason,status,review_note,created_at,updated_at FROM wallet_requests WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`,[tenant])).rows:[];
 const plan_changes=view==='full'||view==='purchases'?await changedPlanHistory(c,tenant):[];
 const covered=new Set(plan_changes.flatMap((e:any)=>[e.purchase_id]));
 for(const p of purchases)if(covered.has(p.purchase_id)){p.can_refund=false;p.refund_unavailable_reason='plan_change_group_refund';p.refund_preview=null;}
 return {balances,purchases,plan_changes,requests,recharge_enabled:checkoutEnabled(),currency:'CNY'};
});}

export async function walletTopup(tenant:string,actor:string,raw:any,requestId:string){
 if(!checkoutEnabled())throw new WalletError('checkout_disabled',503);
 const idempotency=key(raw),amount=parseYuan(raw.amount);
 if(amount>1_000_000||!['desktop','mobile'].includes(raw.device))throw new WalletError('invalid_request',400);
 const config=alipayConfigFromEnv();if(config.mode!=='live')throw new WalletError('checkout_disabled',503);
 return tx(tenant,async c=>{
 let o=(await c.query(`SELECT o.*,t.expires_at FROM payment_orders o JOIN wallet_topups t USING(payment_order_id) WHERE o.tenant_id=$1 AND o.idempotency_key=$2`,[tenant,`topup:${idempotency}`])).rows[0];
 if(o){if(Number(o.amount_minor)!==amount)throw new WalletError('idempotency_conflict');if(o.status!=='pending_payment'||new Date(o.expires_at)<new Date())throw new WalletError('checkout_expired');}
 else {
  if((await c.query(`SELECT 1 FROM wallet_topups t JOIN payment_orders o USING(payment_order_id) WHERE t.tenant_id=$1 AND o.status='pending_payment' AND t.expires_at>NOW() LIMIT 3`,[tenant])).rowCount===3)throw new WalletError('topup_in_progress');
  o=(await c.query(`INSERT INTO payment_orders(tenant_id,order_number,idempotency_key,request_hash,product_code,provider,currency,amount_minor,created_by) VALUES($1,$2,$3,$4,'wallet.topup.v2','alipay','CNY',$5,$6) RETURNING *`,[tenant,`RN${randomUUID().replaceAll('-','').slice(0,20).toUpperCase()}`,`topup:${idempotency}`,createHash('sha256').update(`topup:${amount}`).digest('hex'),amount,actor])).rows[0];
  const t=(await c.query(`INSERT INTO wallet_topups(payment_order_id,tenant_id,payment_mode) VALUES($1,$2,'live') RETURNING expires_at`,[o.payment_order_id,tenant])).rows[0];o.expires_at=t.expires_at;
  await c.query(`INSERT INTO payment_order_status_events(tenant_id,payment_order_id,from_status,to_status,outcome,reason) VALUES($1,$2,NULL,'pending_payment','applied','wallet_topup_created')`,[tenant,o.payment_order_id]);
  await audit(c,tenant,actor,'wallet.topup_created',o.payment_order_id,requestId);
 }
 return {payment_order_id:o.payment_order_id,amount_minor:amount,checkout_url:buildAlipayCheckout(config,{orderNumber:o.order_number,amountMinor:amount,currency:'CNY',subject:'答巢账户充值'},raw.device),expires_at:o.expires_at};
 });
}

export async function walletPurchase(tenant:string,actor:string,raw:any,requestId:string){
 const idempotency=key(raw);if(!uuid.test(raw.plan_version_id??'')||!['monthly','annual'].includes(raw.billing_period)||raw.accepted!==true)throw new WalletError('invalid_request',400);
 return tx(tenant,async c=>{
 const replay=(await c.query('SELECT * FROM wallet_purchases WHERE tenant_id=$1 AND idempotency_key=$2',[tenant,idempotency])).rows[0];
 if(replay){if(replay.plan_version_id!==raw.plan_version_id||replay.billing_period!==raw.billing_period)throw new WalletError('idempotency_conflict');return replay;}
 if((await c.query(`SELECT 1 FROM wallet_requests WHERE tenant_id=$1 AND kind='plan_refund' AND status IN ('requested','approved') UNION ALL SELECT 1 FROM payment_refund_requests WHERE tenant_id=$1 AND status NOT IN ('succeeded','rejected')`,[tenant])).rowCount)throw new WalletError('refund_in_progress');
 if((await c.query(`SELECT 1 FROM plan_payment_purchases p JOIN payment_orders o USING(payment_order_id) WHERE p.tenant_id=$1 AND ((o.status='pending_payment' AND p.expires_at>NOW()) OR (o.status='paid' AND p.status<>'fulfilled'))`,[tenant])).rowCount)throw new WalletError('checkout_in_progress');
 const p=(await c.query(`SELECT * FROM plan_catalog_versions WHERE plan_version_id=$1 AND status='active' AND effective_from<=NOW() AND (effective_until IS NULL OR effective_until>NOW()) FOR SHARE`,[raw.plan_version_id])).rows[0];
 if(!p||!['starter','professional'].includes(p.plan_code)||p.currency!=='CNY'||p.billing_period!=='monthly'||!Number.isSafeInteger(Number(p.price_minor))||Number(p.price_minor)<=0)throw new WalletError('plan_unavailable');
 const snapshot=validateEntitlements(p.entitlement_rules),amount=Number(p.price_minor)*(raw.billing_period==='annual'?8:1),balance=await funds(c,tenant);
 const allocation=allocatePayment(amount,balance.gift_minor,balance.available_cash_minor),gifts=takeGifts(balance.lots,allocation.gift_minor);
 const current=(await c.query(`SELECT s.*,p.plan_code,(s.current_period_end IS NULL OR s.current_period_end>NOW()) AS unexpired FROM tenant_subscriptions s JOIN plan_catalog_versions p USING(plan_version_id) WHERE s.tenant_id=$1 AND s.status IN ('active','trialing','past_due') FOR UPDATE OF s`,[tenant])).rows[0];
 const trial=current?.status==='trialing';
 const renewal=current?.source==='payment'&&current.status==='active'&&current.unexpired&&current.plan_code===p.plan_code&&isDeepStrictEqual(validateEntitlements(current.entitlement_snapshot),snapshot);
 if(current?.unexpired&&current.plan_code!=='free'&&!trial&&!renewal)throw new WalletError('plan_change_requires_review');
 const period=(await c.query(`SELECT COALESCE($1::timestamptz,NOW()) AS starts,((COALESCE($1::timestamptz,NOW()) AT TIME ZONE 'Asia/Shanghai')+($2::int*INTERVAL '1 month')) AT TIME ZONE 'Asia/Shanghai' AS ends`,[renewal?current.current_period_end:null,raw.billing_period==='annual'?12:1])).rows[0];
 let subscription:string;
 if(renewal){subscription=current.subscription_id;await c.query('UPDATE tenant_subscriptions SET current_period_end=$2,cancel_at_period_end=FALSE,updated_at=NOW() WHERE subscription_id=$1',[subscription,period.ends]);}
 else {if(current)await c.query(`UPDATE tenant_subscriptions SET status=$2,updated_at=NOW() WHERE subscription_id=$1`,[current.subscription_id,current.unexpired?'canceled':'expired']);
 const retained=await refundAiCycleAnchor(c,tenant);
 subscription=(await c.query(`INSERT INTO tenant_subscriptions(tenant_id,plan_version_id,status,source,provider,current_period_start,current_period_end,price_minor_snapshot,currency_snapshot,entitlement_snapshot) VALUES($1,$2,'active','payment','wallet',$3,$4,$5,'CNY',$6) RETURNING subscription_id`,[tenant,p.plan_version_id,period.starts,period.ends,amount,JSON.stringify({...snapshot,...(retained?{ai_cycle_anchor:retained}:{})})])).rows[0].subscription_id;}
 const purchase=(await c.query(`INSERT INTO wallet_purchases(tenant_id,idempotency_key,plan_version_id,plan_name,billing_period,amount_minor,gift_minor,cash_minor,gift_allocations,entitlement_snapshot,subscription_id,period_start,period_end,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[tenant,idempotency,p.plan_version_id,p.name,raw.billing_period,amount,allocation.gift_minor,allocation.cash_minor,JSON.stringify(gifts),JSON.stringify(snapshot),subscription,period.starts,period.ends,actor])).rows[0];
 await postLedgerInTransaction(c,tenant,{transaction_type:'charge',currency:'CNY',idempotency_key:`wallet-purchase:${purchase.purchase_id}`,source_type:'wallet_purchase',source_id:purchase.purchase_id,occurred_at:purchase.created_at.toISOString(),metadata:{gift_allocations:gifts},entries:[...(allocation.gift_minor?[{account:'gift',direction:'debit',amount_minor:allocation.gift_minor}]:[]),...(allocation.cash_minor?[{account:'cash',direction:'debit',amount_minor:allocation.cash_minor}]:[]),{account:'revenue',direction:'credit',amount_minor:amount}]},{actor_id:actor,request_id:requestId});
 await c.query(`UPDATE trial_entitlements SET status='converted',updated_at=NOW() WHERE tenant_id=$1 AND status='active'`,[tenant]);
 await c.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,event_key,facts) VALUES($1,$2,$3,'wallet',$4,$5)`,[tenant,subscription,renewal?'renewed':'activated',`wallet:${purchase.purchase_id}`,JSON.stringify({purchase_id:purchase.purchase_id,period_start:period.starts,period_end:period.ends})]);
 await capturePlanCommission(c,purchase);
 await audit(c,tenant,actor,'wallet.plan_purchased',purchase.purchase_id,requestId);return purchase;
 });
}

export async function walletRequest(tenant:string,actor:string,raw:any,requestId:string){
 const idempotency=key(raw);if(!['cash_refund','referral_withdrawal','plan_refund'].includes(raw.kind)||typeof raw.reason!=='string'||raw.reason.trim().length<5||raw.reason.length>256||raw.accepted!==true)throw new WalletError('invalid_request',400);
 return tx(tenant,async c=>{
 const existing=(await c.query('SELECT * FROM wallet_requests WHERE tenant_id=$1 AND idempotency_key=$2',[tenant,idempotency])).rows[0];
 if(existing){if(existing.kind!==raw.kind||existing.reason!==raw.reason.trim()||(raw.kind==='plan_refund'?existing.purchase_id!==raw.purchase_id||(existing.quote.change_event_id??null)!==(raw.change_event_id??null):Number(existing.amount_minor)!==parseYuan(raw.amount)))throw new WalletError('idempotency_conflict');return existing;}
 let quote:any,amount:number,purchaseId:string|null=null;
 if(raw.kind==='plan_refund'){
  if(!uuid.test(raw.purchase_id??''))throw new WalletError('invalid_request',400);
  if(raw.change_event_id){
   if(!uuid.test(raw.change_event_id))throw new WalletError('invalid_request',400);
   const group=await changedPlanRefund(c,tenant,raw.change_event_id);
   if(group.event.facts.refund_purchase_id!==raw.purchase_id)throw new WalletError('invalid_request',400);
   quote=group.quote;amount=quote.original_minor;purchaseId=raw.purchase_id;
  }else{
  const p=(await c.query('SELECT * FROM wallet_purchases WHERE tenant_id=$1 AND purchase_id=$2',[tenant,raw.purchase_id])).rows[0];if(!p)throw new WalletError('purchase_not_found',404);
  if((await c.query(`SELECT 1 FROM subscription_events WHERE tenant_id=$1 AND source='wallet_plan_change' AND subscription_id=$2 AND facts->>'refund_purchase_id'=$3`,[tenant,p.subscription_id,p.purchase_id])).rowCount)throw new WalletError('plan_change_group_refund');
  const s=(await c.query('SELECT * FROM tenant_subscriptions WHERE tenant_id=$1 AND subscription_id=$2 FOR UPDATE',[tenant,p.subscription_id])).rows[0];
  if(!s||s.status!=='active'||new Date(s.current_period_end).getTime()!==new Date(p.period_end).getTime())throw new WalletError('refund_term_requires_review');
  const now=(await c.query('SELECT NOW() AS at')).rows[0].at;
  try {const q=quoteRefund(Number(p.amount_minor),p.created_at,p.period_start,p.period_end,now);quote={...q,...splitRefund(q.amount_minor,Number(p.gift_minor),Number(p.cash_minor)),net_minor:q.amount_minor,policy_version:2};}catch(e){throw new WalletError(e instanceof Error?e.message:'invalid_refund');}
  amount=Number(p.amount_minor);purchaseId=p.purchase_id;
  }
  if((await c.query(`SELECT 1 FROM wallet_requests WHERE purchase_id=$1 AND status<>'rejected'`,[purchaseId])).rowCount)throw new WalletError('refund_already_requested');
 }else{
  amount=parseYuan(raw.amount);const f=await funds(c,tenant);if(amount>(raw.kind==='cash_refund'?f.available_cash_minor:f.available_referral_minor))throw new WalletError('insufficient_balance');quote=feeQuote(amount);
 }
 const result=(await c.query(`INSERT INTO wallet_requests(tenant_id,idempotency_key,kind,purchase_id,amount_minor,fee_minor,net_minor,quote,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[tenant,idempotency,raw.kind,purchaseId,amount,quote.fee_minor,quote.net_minor,JSON.stringify(quote),raw.reason.trim(),actor])).rows[0];
 await audit(c,tenant,actor,'wallet.request_created',result.request_id,requestId);return result;
 });
}
export async function listWalletRequests(){return (await pool.query(`SELECT r.*,t.name AS tenant_name,u.email AS applicant_email FROM wallet_requests r JOIN tenants t USING(tenant_id) LEFT JOIN platform_users u ON u.platform_user_id::text=r.created_by ORDER BY r.created_at DESC LIMIT 200`)).rows;}
export async function reviewWalletRequest(id:string,action:string,actor:string,raw:any,requestId:string){
 if(!uuid.test(id)||!['approve','reject','paid'].includes(action)||typeof raw.reason!=='string'||raw.reason.trim().length<10||raw.reason.length>256)throw new WalletError('invalid_request',400);
 const tenant=(await pool.query('SELECT tenant_id FROM wallet_requests WHERE request_id=$1',[id])).rows[0]?.tenant_id;if(!tenant)throw new WalletError('request_not_found',404);
 return tx(tenant,async c=>{
 const r=(await c.query('SELECT * FROM wallet_requests WHERE request_id=$1 FOR UPDATE',[id])).rows[0];
 if(r.status==='paid'&&((action==='paid'&&r.receipt_reference===raw.receipt_reference)||(action==='approve'&&r.kind==='plan_refund')))return r;
 if(r.status==='rejected'&&action==='reject')return r;
 if(action==='approve'&&r.status==='approved')return r;
 if(!['requested','approved'].includes(r.status))throw new WalletError('request_already_finished');
 if(action==='reject'){await c.query(`UPDATE wallet_requests SET status='rejected',reviewed_by=$2,review_note=$3,updated_at=NOW() WHERE request_id=$1`,[id,actor,raw.reason.trim()]);}
 else if(r.kind==='plan_refund'){
  if(action!=='approve')throw new WalletError('invalid_action');
  if(r.quote.change_event_id){
   // Approval uses the frozen request quote, not a fresh valuation or refund window.
   const e=(await c.query(`SELECT e.facts,s.subscription_id,s.status,s.current_period_end FROM subscription_events e JOIN tenant_subscriptions s ON s.subscription_id=e.subscription_id AND s.tenant_id=e.tenant_id WHERE e.tenant_id=$1 AND e.subscription_event_id=$2 AND e.source='wallet_plan_change' FOR UPDATE OF s`,[tenant,r.quote.change_event_id])).rows[0];
   if(!e||e.status!=='active'||+e.current_period_end!==+new Date(r.quote.period_end)||e.subscription_id!==r.quote.subscription_id)throw new WalletError('refund_term_requires_review');
   for(const origin of r.quote.refund_origins)await reducePlanCommission(c,origin.purchase_id,origin.retained_service_minor,origin.original_minor);
   await postLedgerInTransaction(c,tenant,{transaction_type:'refund',currency:'CNY',idempotency_key:`wallet-refund:${id}`,source_type:'wallet_plan_refund',source_id:id,occurred_at:r.created_at.toISOString(),entries:[{account:'revenue',direction:'debit',amount_minor:Number(r.net_minor)},...(Number(r.quote.cash_minor)?[{account:'cash',direction:'credit',amount_minor:Number(r.quote.cash_minor)}]:[]),...r.quote.gift_allocations.map((g:any)=>({account:'gift',direction:'credit',amount_minor:g.amount_minor,expires_at:g.expires_at}))]},{actor_id:actor,request_id:requestId});
   await c.query(`UPDATE tenant_subscriptions SET status='canceled',updated_at=NOW() WHERE subscription_id=$1`,[e.subscription_id]);
   await c.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,event_key,facts) VALUES($1,$2,'plan_changed','wallet_refund',$3,$4)`,[tenant,e.subscription_id,`wallet-refund:${id}`,JSON.stringify({change_event_id:r.quote.change_event_id,purchase_id:r.purchase_id})]);
   await c.query(`UPDATE wallet_requests SET status='paid',reviewed_by=$2,review_note=$3,receipt_reference=$4,updated_at=NOW() WHERE request_id=$1`,[id,actor,raw.reason.trim(),`wallet:${id}`]);
  }else{
  const p=(await c.query('SELECT * FROM wallet_purchases WHERE purchase_id=$1',[r.purchase_id])).rows[0],s=(await c.query('SELECT * FROM tenant_subscriptions WHERE subscription_id=$1 FOR UPDATE',[p.subscription_id])).rows[0];
  if(s.status!=='active'||new Date(s.current_period_end).getTime()!==new Date(p.period_end).getTime())throw new WalletError('refund_term_requires_review');
  // Each restored gift keeps its original expiry; expired gifts never become spendable cash.
  const gifts=takeGifts(p.gift_allocations,Number(r.quote.gift_minor));
  await reducePlanCommission(c,p.purchase_id,Number(r.quote.usage_minor),Number(p.amount_minor));
  await postLedgerInTransaction(c,tenant,{transaction_type:'refund',currency:'CNY',idempotency_key:`wallet-refund:${id}`,source_type:'wallet_plan_refund',source_id:id,occurred_at:r.created_at.toISOString(),entries:[{account:'revenue',direction:'debit',amount_minor:Number(r.net_minor)},...(Number(r.quote.cash_minor)?[{account:'cash',direction:'credit',amount_minor:Number(r.quote.cash_minor)}]:[]),...gifts.map(g=>({account:'gift',direction:'credit',amount_minor:g.amount_minor,expires_at:g.expires_at}))]},{actor_id:actor,request_id:requestId});
  if(new Date(p.period_start)>new Date(s.current_period_start))await c.query(`UPDATE tenant_subscriptions SET current_period_end=$2,status=CASE WHEN $2::timestamptz>NOW() THEN 'active' ELSE 'expired' END,updated_at=NOW() WHERE subscription_id=$1`,[s.subscription_id,p.period_start]);
  else await c.query(`UPDATE tenant_subscriptions SET status='canceled',updated_at=NOW() WHERE subscription_id=$1`,[s.subscription_id]);
  await c.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,event_key,facts) VALUES($1,$2,'plan_changed','wallet_refund',$3,$4)`,[tenant,s.subscription_id,`wallet-refund:${id}`,JSON.stringify({purchase_id:p.purchase_id,removed_period_start:p.period_start,removed_period_end:p.period_end})]);
  await c.query(`UPDATE wallet_requests SET status='paid',reviewed_by=$2,review_note=$3,receipt_reference=$4,updated_at=NOW() WHERE request_id=$1`,[id,actor,raw.reason.trim(),`wallet:${id}`]);
  }
 }else{
  const f=await funds(c,tenant),account=r.kind==='cash_refund'?'cash':'referral';
  if((account==='cash'?f.cash_minor-f.frozen_cash_minor:f.referral_minor-f.frozen_referral_minor)<0)throw new WalletError('balance_requires_review');
  if(action==='approve'){if(r.status!=='requested')throw new WalletError('invalid_action');await c.query(`UPDATE wallet_requests SET status='approved',reviewed_by=$2,review_note=$3,updated_at=NOW() WHERE request_id=$1`,[id,actor,raw.reason.trim()]);}
  else{
   if(r.status!=='approved'||raw.confirmed!=='yes'||typeof raw.receipt_reference!=='string'||!/^[A-Za-z0-9:_-]{6,100}$/.test(raw.receipt_reference))throw new WalletError('receipt_required',400);
   await postLedgerInTransaction(c,tenant,{transaction_type:'refund',currency:'CNY',idempotency_key:`wallet-payout:${id}`,source_type:account==='referral'?'referral_wallet_payout':'wallet_payout',source_id:id,occurred_at:new Date().toISOString(),entries:[{account,direction:'debit',amount_minor:Number(r.amount_minor)},{account:'clearing',direction:'credit',amount_minor:Number(r.net_minor)},...(Number(r.fee_minor)?[{account:'revenue',direction:'credit',amount_minor:Number(r.fee_minor)}]:[])]},{actor_id:actor,request_id:requestId});
   await c.query(`UPDATE wallet_requests SET status='paid',reviewed_by=$2,review_note=$3,receipt_reference=$4,updated_at=NOW() WHERE request_id=$1`,[id,actor,raw.reason.trim(),raw.receipt_reference]);
  }
 }
 await audit(c,tenant,actor,`wallet.request_${action}`,id,requestId);return (await c.query('SELECT * FROM wallet_requests WHERE request_id=$1',[id])).rows[0];
 });
}
