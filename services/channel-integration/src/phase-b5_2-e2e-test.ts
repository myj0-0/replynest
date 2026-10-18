import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrate, pool } from "./database.js";
import { createPaymentOrder, PaymentOrderConflictError, PaymentOrderNotFoundError, recordSyntheticPaymentEvent } from "./payment-order.js";

await migrate();
const marker = `${Date.now()}-${Math.floor(Math.random()*10000)}`;
const accountBase = BigInt(Date.now()) * 100n;
const actor = () => ({ actor_id: "phase-b5.2-e2e", request_id: randomUUID() });
async function tenant(suffix: string, offset: number) {
  const tenantId = `phase-b5-2-${marker}-${suffix}`;
  await pool.query(`INSERT INTO tenants(tenant_id,name,status,chatwoot_account_id,signup_source) VALUES($1,$1,'test',$2,'synthetic-phase-b5.2')`, [tenantId, (accountBase+BigInt(offset)).toString()]);
  return tenantId;
}

const first = await tenant("a",1), second = await tenant("b",2);
const input = { idempotency_key: `create-${marker}`, product_code: "pro.monthly", provider: "synthetic", currency: "CNY", amount_minor: 9900 };
const created = await createPaymentOrder(first,input,actor());
assert.equal(created.status,"pending_payment");
assert.match(created.order_number,/^RN[0-9A-Z]{20}$/);
const replay = await createPaymentOrder(first,input,actor());
assert.equal(replay.payment_order_id,created.payment_order_id);
assert.equal(replay.idempotent_replay,true);
await assert.rejects(()=>createPaymentOrder(first,{...input,amount_minor:19900},actor()),PaymentOrderConflictError);
await assert.rejects(()=>recordSyntheticPaymentEvent(second,created.payment_order_id,{provider_event_id:`cross-${marker}`,event_type:"payment_succeeded",amount_minor:9900,currency:"CNY",occurred_at:new Date().toISOString()},actor()),PaymentOrderNotFoundError);

const refund = {provider_event_id:`refund-${marker}`,event_type:"payment_refunded" as const,amount_minor:9900,currency:"CNY",occurred_at:new Date(Date.now()+1000).toISOString()};
await recordSyntheticPaymentEvent(first,created.payment_order_id,refund,actor());
assert.equal((await pool.query(`SELECT status FROM payment_orders WHERE payment_order_id=$1`,[created.payment_order_id])).rows[0].status,"pending_payment");
const paid = {provider_event_id:`paid-${marker}`,event_type:"payment_succeeded" as const,amount_minor:9900,currency:"CNY",occurred_at:new Date().toISOString(),provider_order_id:`synthetic-${marker}`};
const settled = await recordSyntheticPaymentEvent(first,created.payment_order_id,paid,actor());
assert.equal(settled.order.status,"refunded");
assert.equal(settled.order.refunded_minor,"9900");
assert.equal((await recordSyntheticPaymentEvent(first,created.payment_order_id,paid,actor())).idempotent_replay,true);
await assert.rejects(()=>recordSyntheticPaymentEvent(first,created.payment_order_id,{...paid,amount_minor:9800},actor()),PaymentOrderConflictError);
const another = await createPaymentOrder(first,{...input,idempotency_key:`create-2-${marker}`},actor());
await assert.rejects(()=>recordSyntheticPaymentEvent(first,another.payment_order_id,paid,actor()),PaymentOrderConflictError);
assert.equal((await pool.query(`SELECT COUNT(*)::int count FROM payment_events WHERE payment_order_id=$1`,[created.payment_order_id])).rows[0].count,2);
assert.equal((await pool.query(`SELECT COUNT(*)::int count FROM payment_order_status_events WHERE payment_order_id=$1 AND outcome='deferred'`,[created.payment_order_id])).rows[0].count,1);
assert.equal((await pool.query(`SELECT COUNT(*)::int count FROM payment_order_status_events WHERE payment_order_id=$1 AND outcome='applied'`,[created.payment_order_id])).rows[0].count,3);
await assert.rejects(()=>pool.query(`DELETE FROM payment_events WHERE payment_order_id=$1`,[created.payment_order_id]));
await assert.rejects(()=>pool.query(`UPDATE payment_order_status_events SET reason='tampered' WHERE payment_order_id=$1`,[created.payment_order_id]));
console.log(`phase_b5_2_e2e=ok marker=${marker} idempotent_order=true cross_tenant_rejected=true cross_order_event_rejected=true out_of_order_refund_reconciled=true duplicate_event_deduped=true append_only=true`);
await pool.end();
