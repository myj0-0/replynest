import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./database.js";
import { applyPaymentEvent, paymentEventTypes, paymentOrderRequestHash, validatePaymentOrderInput, type PaymentEventType, type PaymentOrderFacts } from "./payment-order-core.js";

export class PaymentOrderConflictError extends Error {}
export class PaymentOrderNotFoundError extends Error {}
export type PaymentActor = { actor_id: string; request_id: string };

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const orderNumber = () => `RN${new Date().toISOString().slice(0,10).replaceAll("-","")}${randomBytes(8).toString("hex").slice(0,12).toUpperCase()}`;

async function orderView(client: PoolClient, tenantId: string, orderId: string) {
  const result = await client.query(`SELECT payment_order_id,order_number,product_code,provider,provider_order_id,currency,amount_minor::text,refunded_minor::text,status,ledger_transaction_id,reversal_ledger_transaction_id,paid_at,closed_at,created_at,updated_at FROM payment_orders WHERE tenant_id=$1 AND payment_order_id=$2`, [tenantId, orderId]);
  return result.rows[0];
}

export async function createPaymentOrder(tenantId: string, raw: unknown, actor: PaymentActor) {
  const input = validatePaymentOrderInput(raw);
  const requestHash = paymentOrderRequestHash(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ payment_order_id: string }>(`INSERT INTO payment_orders(tenant_id,order_number,idempotency_key,request_hash,product_code,provider,currency,amount_minor,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING payment_order_id`, [tenantId, orderNumber(), input.idempotency_key, requestHash, input.product_code, input.provider, input.currency, input.amount_minor, actor.actor_id]);
    let paymentOrderId = inserted.rows[0]?.payment_order_id;
    let replay = false;
    if (!paymentOrderId) {
      const existing = await client.query<{ payment_order_id: string; request_hash: string }>(`SELECT payment_order_id,request_hash FROM payment_orders WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE`, [tenantId, input.idempotency_key]);
      if (!existing.rows[0] || existing.rows[0].request_hash !== requestHash) throw new PaymentOrderConflictError("idempotency key already represents different payment order facts");
      paymentOrderId = existing.rows[0].payment_order_id; replay = true;
    } else {
      await client.query(`INSERT INTO payment_order_status_events(tenant_id,payment_order_id,from_status,to_status,outcome,reason) VALUES($1,$2,NULL,'pending_payment','applied','order_created')`, [tenantId, paymentOrderId]);
      await client.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id) VALUES($1,'internal_service',$2,'payment.order_created','payment_order',$3,jsonb_build_object('provider',$4::text,'currency',$5::text,'amount_minor',$6::bigint),$7)`, [tenantId, actor.actor_id, paymentOrderId, input.provider, input.currency, input.amount_minor, actor.request_id]);
    }
    const view = await orderView(client, tenantId, paymentOrderId);
    await client.query("COMMIT");
    return { ...view, idempotent_replay: replay };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export type PaymentEventInput = { provider_event_id: string; event_type: PaymentEventType; amount_minor: number; currency: string; occurred_at: string; provider_order_id?: string };
function validateEvent(raw: PaymentEventInput): PaymentEventInput {
  const event = { ...raw, provider_event_id: String(raw.provider_event_id ?? "").trim(), event_type: String(raw.event_type ?? "") as PaymentEventType, currency: String(raw.currency ?? "").toUpperCase(), occurred_at: new Date(raw.occurred_at).toISOString(), provider_order_id: raw.provider_order_id ? String(raw.provider_order_id).trim() : undefined };
  if (!event.provider_event_id || event.provider_event_id.length > 200 || !paymentEventTypes.includes(event.event_type) || !Number.isSafeInteger(event.amount_minor) || event.amount_minor < 0 || event.currency !== "CNY") throw new Error("invalid payment event");
  return event;
}

async function applyStoredEvent(client: PoolClient, tenantId: string, order: any, paymentEventId: string, event: PaymentEventInput) {
  const facts: PaymentOrderFacts = { status: order.status, amount_minor: Number(order.amount_minor), refunded_minor: Number(order.refunded_minor) };
  const transition = applyPaymentEvent(facts, event.event_type, event.amount_minor);
  await client.query(`INSERT INTO payment_order_status_events(tenant_id,payment_order_id,payment_event_id,from_status,to_status,outcome,reason) VALUES($1,$2,$3,$4,$5,$6,$7)`, [tenantId, order.payment_order_id, paymentEventId, order.status, transition.next_status, transition.outcome, transition.reason]);
  if (transition.outcome === "applied") {
    const paidAt = transition.next_status === "paid" && !order.paid_at ? event.occurred_at : order.paid_at;
    const closedAt = ["refunded","chargeback","cancelled"].includes(transition.next_status) ? event.occurred_at : null;
    await client.query(`UPDATE payment_orders SET status=$3,refunded_minor=$4,provider_order_id=COALESCE(provider_order_id,$5),paid_at=$6,closed_at=$7,updated_at=NOW() WHERE tenant_id=$1 AND payment_order_id=$2`, [tenantId, order.payment_order_id, transition.next_status, transition.next_refunded_minor, event.provider_order_id ?? null, paidAt, closedAt]);
    const operation = event.event_type === "payment_succeeded" ? "settle" : event.event_type === "payment_refunded" ? "refund" : event.event_type === "payment_chargeback" ? "chargeback" : null;
    const projectionAmount = operation === "settle" ? Number(order.amount_minor) : transition.next_refunded_minor - facts.refunded_minor;
    if (operation && projectionAmount > 0) {
      await client.query(`INSERT INTO payment_ledger_outbox(tenant_id,payment_order_id,payment_event_id,operation,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(payment_event_id) DO NOTHING`, [tenantId, order.payment_order_id, paymentEventId, operation, projectionAmount, event.currency]);
    }
    Object.assign(order, { status: transition.next_status, refunded_minor: transition.next_refunded_minor, provider_order_id: order.provider_order_id ?? event.provider_order_id, paid_at: paidAt, closed_at: closedAt });
  }
  return transition;
}

async function recordPaymentEventForProvider(tenantId: string, paymentOrderId: string, requiredProvider: "synthetic" | "wechat_pay" | "alipay", raw: PaymentEventInput, actor: PaymentActor) {
  const event = validateEvent(raw);
  const payloadHash = hash(event);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderResult = await client.query(`SELECT * FROM payment_orders WHERE tenant_id=$1 AND payment_order_id=$2 FOR UPDATE`, [tenantId, paymentOrderId]);
    const order = orderResult.rows[0];
    if (!order) throw new PaymentOrderNotFoundError("payment order not found");
    if (order.provider !== requiredProvider) throw new PaymentOrderConflictError("payment event provider does not match order provider");
    if(requiredProvider==='alipay' && event.event_type==='payment_succeeded' &&
      (event.amount_minor!==Number(order.amount_minor)||event.currency!==order.currency||!event.provider_order_id||(order.provider_order_id && order.provider_order_id!==event.provider_order_id))) {
      throw new PaymentOrderConflictError('alipay_payment_facts_mismatch');
    }
    const duplicate = await client.query<{ payment_event_id: string; payload_hash: string; tenant_id: string; payment_order_id: string }>(`SELECT payment_event_id,payload_hash,tenant_id,payment_order_id FROM payment_events WHERE provider=$1 AND provider_event_id=$2`, [order.provider, event.provider_event_id]);
    if (duplicate.rows[0]) {
      if (duplicate.rows[0].payload_hash !== payloadHash || duplicate.rows[0].tenant_id !== tenantId || duplicate.rows[0].payment_order_id !== paymentOrderId) throw new PaymentOrderConflictError("provider event id already represents a different tenant, order, or facts");
      const view = await orderView(client, tenantId, paymentOrderId); await client.query("COMMIT"); return { order: view, idempotent_replay: true };
    }
    const inserted = await client.query<{ payment_event_id: string }>(`INSERT INTO payment_events(tenant_id,payment_order_id,provider,provider_event_id,event_type,amount_minor,currency,payload_hash,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING payment_event_id`, [tenantId, paymentOrderId, order.provider, event.provider_event_id, event.event_type, event.amount_minor, event.currency, payloadHash, event.occurred_at]);
    await applyStoredEvent(client, tenantId, order, inserted.rows[0].payment_event_id, event);
    if (event.event_type === "payment_succeeded" && order.status === "paid") {
      const deferred = await client.query(`SELECT e.payment_event_id,e.provider_event_id,e.event_type,e.amount_minor::int,e.currency,e.occurred_at FROM payment_events e WHERE e.payment_order_id=$1 AND e.event_type IN ('payment_refunded','payment_chargeback') AND EXISTS(SELECT 1 FROM payment_order_status_events s WHERE s.payment_event_id=e.payment_event_id AND s.outcome='deferred') AND NOT EXISTS(SELECT 1 FROM payment_order_status_events s WHERE s.payment_event_id=e.payment_event_id AND s.outcome IN ('applied','ignored')) ORDER BY e.occurred_at,e.received_at,e.payment_event_id`, [paymentOrderId]);
      for (const item of deferred.rows) await applyStoredEvent(client, tenantId, order, item.payment_event_id, { ...item, amount_minor: Number(item.amount_minor), occurred_at: new Date(item.occurred_at).toISOString() });
    }
    await client.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id) VALUES($1,'internal_service',$2,'payment.event_recorded','payment_order',$3,jsonb_build_object('event_type',$4::text,'provider_event_id',$5::text),$6)`, [tenantId, actor.actor_id, paymentOrderId, event.event_type, event.provider_event_id, actor.request_id]);
    const view = await orderView(client, tenantId, paymentOrderId); await client.query("COMMIT"); return { order: view, idempotent_replay: false };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export function recordSyntheticPaymentEvent(tenantId: string, paymentOrderId: string, raw: PaymentEventInput, actor: PaymentActor) {
  return recordPaymentEventForProvider(tenantId, paymentOrderId, "synthetic", raw, actor);
}

export function recordProviderPaymentEvent(tenantId: string, paymentOrderId: string, provider: "wechat_pay" | "alipay", raw: PaymentEventInput, actor: PaymentActor) {
  return recordPaymentEventForProvider(tenantId, paymentOrderId, provider, raw, actor);
}
