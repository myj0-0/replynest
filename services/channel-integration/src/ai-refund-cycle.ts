import type {PoolClient} from 'pg';

/** Whole-plan refunds remove rights, not consumed AI or the current allowance
 * window. Reuse its original anchor only until the cycle containing the refund
 * ends. Never modify usage bills, credit lots or original payment facts.
 * Future-term refunds do not cancel a subscription and are excluded.
 */
export async function refundAiCycleAnchor(db:Pick<PoolClient,'query'>,tenant:string):Promise<string|null>{
 const row=(await db.query(`WITH receipt AS (
  SELECT COALESCE(s.entitlement_snapshot->>'ai_cycle_anchor',s.current_period_start::text)::timestamptz AS anchor,
   e.created_at AS refunded_at,t.timezone
  FROM subscription_events e JOIN tenant_subscriptions s ON s.subscription_id=e.subscription_id AND s.tenant_id=e.tenant_id
   JOIN tenants t ON t.tenant_id=e.tenant_id
  WHERE e.tenant_id=$1 AND e.source IN('wallet_refund','alipay_refund') AND s.status='canceled' AND s.source='payment'
   AND s.current_period_start IS NOT NULL
  ORDER BY e.created_at DESC,e.subscription_event_id DESC LIMIT 1
 ), local AS (
  SELECT *,anchor AT TIME ZONE timezone AS a,refunded_at AT TIME ZONE timezone AS r FROM receipt
 ), numbered AS (
  SELECT *, (EXTRACT(YEAR FROM r)::int-EXTRACT(YEAR FROM a)::int)*12+
   EXTRACT(MONTH FROM r)::int-EXTRACT(MONTH FROM a)::int AS months FROM local
 ), fence AS (
  SELECT *,a+(months+1-CASE WHEN a+months*INTERVAL '1 month'>r THEN 1 ELSE 0 END)*INTERVAL '1 month' AS ends FROM numbered
 ) SELECT anchor FROM fence WHERE anchor<=refunded_at AND NOW()<(ends AT TIME ZONE timezone)`,[tenant])).rows[0];
 return row?new Date(row.anchor).toISOString():null;
}
