import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { pool } from './database.js';
import { alipayConfigFromEnv, buildAlipayCheckout } from './alipay-provider.js';
import { validateEntitlements } from './subscription-core.js';
import {refundAiCycleAnchor} from './ai-refund-cycle.js';

export class CheckoutError extends Error {
  constructor(public code: string, public httpStatus = 409) { super(code); }
}
export function checkoutEnabled() {
  return process.env.PLAN_CHECKOUT_ENABLED === 'true' && process.env.PAYMENT_PROVIDER === 'alipay'
    && process.env.PAYMENT_LIVE_ENABLED === 'true' && process.env.ALIPAY_NOTIFY_ENABLED === 'true';
}
export function validateCheckoutInput(raw: unknown) {
  const v = raw as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['plan_version_id','idempotency_key','device','billing_period'].includes(k))
    || typeof v.plan_version_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(v.plan_version_id)
    || typeof v.idempotency_key !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(v.idempotency_key)
    || !['desktop','mobile'].includes(String(v.device)) || !['monthly','annual'].includes(String(v.billing_period??'monthly'))) throw new CheckoutError('invalid_checkout', 400);
  return { plan_version_id: v.plan_version_id, idempotency_key: v.idempotency_key, device: v.device as 'desktop'|'mobile',billing_period:(v.billing_period??'monthly') as 'monthly'|'annual' };
}
async function currentSubscription(client: PoolClient, tenantId: string) {
  return (await client.query(`SELECT s.*,p.plan_code,(s.current_period_end IS NULL OR s.current_period_end>NOW()) AS unexpired
    FROM tenant_subscriptions s JOIN plan_catalog_versions p USING(plan_version_id)
    WHERE s.tenant_id=$1 AND s.status IN ('active','trialing','past_due') FOR UPDATE OF s`, [tenantId])).rows[0];
}
function compatible(current: any, plan: any) {
  // Never discard an existing paid/manual term or silently prorate an upgrade.
  return !current || !current.unexpired || current.plan_code === 'free'
    || (current.source === 'payment' && current.status === 'active' && current.plan_code === plan.plan_code
      && isDeepStrictEqual(validateEntitlements(current.entitlement_snapshot),validateEntitlements(plan.entitlement_rules??plan.entitlement_snapshot)) && current.current_period_end);
}
export async function createPlanCheckout(tenantId: string, actorId: string, raw: unknown, requestId: string) {
  if (!checkoutEnabled()) throw new CheckoutError('checkout_disabled', 503);
  const input = validateCheckoutInput(raw), config = alipayConfigFromEnv();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`subscription-change:${tenantId}`]);
    if((await client.query(`SELECT 1 FROM payment_refund_requests WHERE tenant_id=$1 AND status NOT IN ('succeeded','rejected')`,[tenantId])).rowCount)throw new CheckoutError('refund_in_progress');
    const replay = (await client.query(`SELECT o.*,p.plan_version_id,p.plan_name,p.expires_at,p.payment_mode,p.billing_period
      FROM payment_orders o JOIN plan_payment_purchases p USING(payment_order_id)
      WHERE o.tenant_id=$1 AND o.idempotency_key=$2`, [tenantId, `plan:${input.idempotency_key}`])).rows[0];
    let order = replay;
    if (replay) {
      if (replay.plan_version_id !== input.plan_version_id || replay.payment_mode !== config.mode || replay.billing_period!==input.billing_period) throw new CheckoutError('checkout_conflict');
      if (replay.status !== 'pending_payment' || new Date(replay.expires_at).getTime() <= Date.now()) throw new CheckoutError('checkout_expired');
    } else {
      const plan = (await client.query(`SELECT * FROM plan_catalog_versions WHERE plan_version_id=$1 AND status='active'
        AND effective_from<=NOW() AND (effective_until IS NULL OR effective_until>NOW()) FOR SHARE`, [input.plan_version_id])).rows[0];
      if (!plan || !['starter','professional'].includes(plan.plan_code) || plan.billing_period !== 'monthly'
        || !Number.isSafeInteger(Number(plan.price_minor)) || Number(plan.price_minor)<=0 || plan.currency !== 'CNY') throw new CheckoutError('plan_unavailable');
      const snapshot = validateEntitlements(plan.entitlement_rules);
      if (!compatible(await currentSubscription(client, tenantId), plan)) throw new CheckoutError('plan_change_requires_review');
      // Prevent double-clicks with different keys from opening concurrent checkouts.
      const pending = await client.query(`SELECT 1 FROM plan_payment_purchases p JOIN payment_orders o USING(payment_order_id)
        WHERE p.tenant_id=$1 AND ((o.status='pending_payment' AND p.expires_at>NOW()) OR (o.status='paid' AND p.status<>'fulfilled'))`, [tenantId]);
      if (pending.rowCount) throw new CheckoutError('checkout_in_progress');
      const number = `RN${new Date().toISOString().slice(0,10).replaceAll('-','')}${randomBytes(6).toString('hex').toUpperCase()}`;
      const amount=Number(plan.price_minor)*(input.billing_period==='annual'?8:1);
      if(!Number.isSafeInteger(amount)||amount<=0)throw new CheckoutError('plan_unavailable');
      const facts = { plan: plan.plan_version_id, amount: String(amount), mode: config.mode,billing_period:input.billing_period,refund_policy_version:1 };
      order = (await client.query(`INSERT INTO payment_orders(tenant_id,order_number,idempotency_key,request_hash,product_code,provider,currency,amount_minor,created_by)
        VALUES($1,$2,$3,$4,$5,'alipay','CNY',$6,$7) RETURNING *`, [tenantId, number, `plan:${input.idempotency_key}`, createHash('sha256').update(JSON.stringify(facts)).digest('hex'), `${plan.plan_code}.${input.billing_period}.v${plan.version}`, amount, actorId])).rows[0];
      const purchase = (await client.query(`INSERT INTO plan_payment_purchases(payment_order_id,tenant_id,plan_version_id,plan_code,plan_name,entitlement_snapshot,amount_minor,currency,payment_mode,billing_period,refund_policy_version)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'CNY',$8,$9,1) RETURNING expires_at`, [order.payment_order_id, tenantId, plan.plan_version_id, plan.plan_code, plan.name, JSON.stringify(snapshot), amount, config.mode,input.billing_period])).rows[0];
      order.plan_name = plan.name; order.expires_at = purchase.expires_at;
      await client.query(`INSERT INTO payment_order_status_events(tenant_id,payment_order_id,from_status,to_status,outcome,reason) VALUES($1,$2,NULL,'pending_payment','applied','plan_checkout_created')`, [tenantId, order.payment_order_id]);
      await client.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
        VALUES($1,'tenant_user',$2,'billing.checkout_created','payment_order',$3,$4::jsonb,$5)`, [tenantId, actorId, order.payment_order_id, JSON.stringify(facts), requestId]);
    }
    const url = buildAlipayCheckout(config, { orderNumber: order.order_number, amountMinor: Number(order.amount_minor), currency: order.currency, subject: `答巢 ${order.plan_name} ${input.billing_period==='annual'?'年付':'月付'}套餐` }, input.device);
    await client.query('COMMIT');
    return { payment_order_id: order.payment_order_id, order_number: order.order_number, amount_minor: String(order.amount_minor), currency: order.currency, checkout_url: url, expires_at: order.expires_at };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

/** Only settled, ledger-projected live orders grant production entitlements. Retried safely after crashes. */
export async function fulfillPlanPurchase(orderId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenant = (await client.query('SELECT tenant_id FROM plan_payment_purchases WHERE payment_order_id=$1', [orderId])).rows[0];
    if (!tenant) { await client.query('COMMIT'); return false; }
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`subscription-change:${tenant.tenant_id}`]);
    const p = (await client.query(`SELECT p.*,o.status AS payment_status,o.amount_minor AS paid_amount,o.currency AS paid_currency,o.ledger_transaction_id
      FROM plan_payment_purchases p JOIN payment_orders o USING(payment_order_id) WHERE p.payment_order_id=$1 FOR UPDATE OF p,o`, [orderId])).rows[0];
    if (p.status !== 'pending' || p.payment_status !== 'paid' || !p.ledger_transaction_id) { await client.query('COMMIT'); return false; }
    if((await client.query(`SELECT 1 FROM payment_refund_requests WHERE tenant_id=$1 AND status NOT IN ('succeeded','rejected')`,[p.tenant_id])).rowCount){await client.query('COMMIT');return false;}
    const current = await currentSubscription(client, p.tenant_id);
    const reason = p.payment_mode !== 'live' ? 'sandbox_no_production_entitlements'
      : String(p.amount_minor)!==String(p.paid_amount) || p.currency!==p.paid_currency ? 'payment_facts_mismatch'
      : !compatible(current,p) ? 'subscription_changed_after_checkout' : null;
    if (reason) {
      await client.query(`UPDATE plan_payment_purchases SET status='review',review_reason=$2 WHERE payment_order_id=$1`, [orderId,reason]);
      await client.query('COMMIT'); return false;
    }
    let subscriptionId: string, period: any;
    if (current?.source === 'payment' && current.unexpired && current.plan_code === p.plan_code) {
      period = (await client.query(`SELECT $1::timestamptz AS starts, (($1::timestamptz AT TIME ZONE 'Asia/Shanghai')+($2::int*INTERVAL '1 month')) AT TIME ZONE 'Asia/Shanghai' AS ends`, [current.current_period_end,p.billing_period==='annual'?12:1])).rows[0];
      subscriptionId = current.subscription_id;
      await client.query(`UPDATE tenant_subscriptions SET current_period_end=$2,cancel_at_period_end=FALSE,updated_at=NOW() WHERE subscription_id=$1`, [subscriptionId, period.ends]);
    } else {
      if (current) await client.query(`UPDATE tenant_subscriptions SET status=$2,updated_at=NOW() WHERE subscription_id=$1`, [current.subscription_id, current.unexpired?'canceled':'expired']);
      period = (await client.query(`SELECT NOW() AS starts, ((NOW() AT TIME ZONE 'Asia/Shanghai')+($1::int*INTERVAL '1 month')) AT TIME ZONE 'Asia/Shanghai' AS ends`,[p.billing_period==='annual'?12:1])).rows[0];
      const retained=await refundAiCycleAnchor(client,p.tenant_id);
      subscriptionId = (await client.query(`INSERT INTO tenant_subscriptions(tenant_id,plan_version_id,status,source,provider,current_period_start,current_period_end,price_minor_snapshot,currency_snapshot,entitlement_snapshot)
        VALUES($1,$2,'active','payment','alipay',$3,$4,$5,$6,$7::jsonb) RETURNING subscription_id`, [p.tenant_id,p.plan_version_id,period.starts,period.ends,p.amount_minor,p.currency,JSON.stringify({...p.entitlement_snapshot,...(retained?{ai_cycle_anchor:retained}:{})})])).rows[0].subscription_id;
    }
    await client.query(`UPDATE trial_entitlements SET status='converted',updated_at=NOW() WHERE tenant_id=$1 AND status='active'`, [p.tenant_id]);
    await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,event_key,facts)
      VALUES($1,$2,$3,'alipay',$4,$5::jsonb)`, [p.tenant_id,subscriptionId,current?.subscription_id===subscriptionId?'renewed':'activated',`payment:${orderId}`,JSON.stringify({payment_order_id:orderId,period_start:period.starts,period_end:period.ends})]);
    await client.query(`UPDATE plan_payment_purchases SET status='fulfilled',subscription_id=$2,period_start=$3,period_end=$4,fulfilled_at=NOW() WHERE payment_order_id=$1`, [orderId,subscriptionId,period.starts,period.ends]);
    await client.query('COMMIT'); return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export async function processPlanPurchases() {
  const rows = await pool.query(`SELECT p.payment_order_id FROM plan_payment_purchases p JOIN payment_orders o USING(payment_order_id)
    WHERE p.status='pending' AND o.status='paid' AND o.ledger_transaction_id IS NOT NULL ORDER BY p.created_at LIMIT 20`);
  for (const row of rows.rows) await fulfillPlanPurchase(row.payment_order_id);
}
