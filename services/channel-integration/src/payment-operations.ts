import { pool } from "./database.js";
import { paymentOrderStatuses, type PaymentOrderStatus } from "./payment-order-core.js";

export async function listPaymentOrders(tenantId: string, options: { page: number; limit: number; status?: string }) {
  const page = Number.isInteger(options.page) ? Math.max(1, options.page) : 1;
  const limit = Number.isInteger(options.limit) ? Math.min(100, Math.max(1, options.limit)) : 20;
  const status = options.status?.trim() || undefined;
  if (status && !paymentOrderStatuses.includes(status as PaymentOrderStatus)) throw new Error("invalid payment order status");
  const result = await pool.query(`
    SELECT p.payment_order_id,p.order_number,p.product_code,p.provider,p.provider_order_id,p.currency,
           p.amount_minor::text,p.refunded_minor::text,p.status,p.paid_at,p.closed_at,p.created_at,p.updated_at,
           (SELECT jsonb_build_object('status',r.status,'amount_minor',r.amount_minor::text) FROM payment_refund_requests r WHERE r.payment_order_id=p.payment_order_id AND r.tenant_id=p.tenant_id) AS refund_request,
           (SELECT jsonb_build_object('status',s.status,'period_end',s.period_end,'review_reason',s.review_reason,'payment_mode',s.payment_mode) FROM plan_payment_purchases s WHERE s.payment_order_id=p.payment_order_id AND s.tenant_id=p.tenant_id) AS fulfillment,
           COALESCE(COUNT(o.outbox_id),0)::int AS projection_count,
           COALESCE(COUNT(o.outbox_id) FILTER (WHERE o.status='succeeded'),0)::int AS projected_count,
           COALESCE(COUNT(o.outbox_id) FILTER (WHERE o.status='dead'),0)::int AS projection_dead_count
      FROM payment_orders p LEFT JOIN payment_ledger_outbox o ON o.payment_order_id=p.payment_order_id AND o.tenant_id=p.tenant_id
     WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.status=$2)
     GROUP BY p.payment_order_id
     ORDER BY p.created_at DESC,p.payment_order_id DESC LIMIT $3 OFFSET $4`,
    [tenantId, status ?? null, limit + 1, (page - 1) * limit]);
  return { data: result.rows.slice(0, limit), pagination: { page, limit, has_next: result.rows.length > limit } };
}

export async function paymentOperationsOverview(tenantId: string, windowDays = 30) {
  const days = Number.isInteger(windowDays) ? Math.min(90, Math.max(1, windowDays)) : 30;
  const orders = await pool.query(`
    SELECT COUNT(*)::int AS created_orders,
           COUNT(*) FILTER (WHERE paid_at IS NOT NULL)::int AS settled_orders,
           COUNT(*) FILTER (WHERE status='pending_payment')::int AS pending_orders,
           COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled_orders,
           COUNT(*) FILTER (WHERE status IN ('partially_refunded','refunded','chargeback'))::int AS affected_by_refund_orders,
           COALESCE(SUM(amount_minor) FILTER (WHERE paid_at IS NOT NULL),0)::text AS gross_minor,
           COALESCE(SUM(refunded_minor),0)::text AS refunded_minor
      FROM payment_orders WHERE tenant_id=$1 AND created_at>=NOW()-($2::text||' days')::interval`, [tenantId, days]);
  const outbox = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE status IN ('pending','processing'))::int AS pending,
           COUNT(*) FILTER (WHERE status='dead')::int AS dead,
           COALESCE(EXTRACT(EPOCH FROM (NOW()-MIN(created_at) FILTER (WHERE status IN ('pending','processing')))),0)::int AS oldest_pending_seconds
      FROM payment_ledger_outbox WHERE tenant_id=$1`, [tenantId]);
  const row = orders.rows[0];
  const gross = BigInt(row.gross_minor);
  const refunded = BigInt(row.refunded_minor);
  return {
    window_days: days,
    created_orders: row.created_orders,
    settled_orders: row.settled_orders,
    pending_orders: row.pending_orders,
    cancelled_orders: row.cancelled_orders,
    affected_by_refund_orders: row.affected_by_refund_orders,
    conversion_rate: row.created_orders > 0 ? Math.round(row.settled_orders / row.created_orders * 10_000) / 100 : 0,
    currency: "CNY",
    gross_minor: gross.toString(),
    refunded_minor: refunded.toString(),
    net_minor: (gross - refunded).toString(),
    projection: outbox.rows[0]
  };
}

export async function paymentProjectionHealth() {
  const result = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE status IN ('pending','processing'))::int AS pending,
           COUNT(*) FILTER (WHERE status='dead')::int AS dead,
           COALESCE(EXTRACT(EPOCH FROM (NOW()-MIN(created_at) FILTER (WHERE status IN ('pending','processing')))),0)::int AS oldest_pending_seconds
      FROM payment_ledger_outbox`);
  const data = result.rows[0] as { pending: number; dead: number; oldest_pending_seconds: number };
  return { ...data, status: data.dead > 0 || data.oldest_pending_seconds > 120 ? "unavailable" : data.pending > 20 ? "degraded" : "operational" };
}
