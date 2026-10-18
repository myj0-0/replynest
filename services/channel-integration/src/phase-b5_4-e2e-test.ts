import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrate, pool } from "./database.js";
import { processPaymentLedgerOutbox } from "./payment-ledger-outbox.js";
import { listPaymentOrders, paymentOperationsOverview } from "./payment-operations.js";
import { createPaymentOrder, recordSyntheticPaymentEvent } from "./payment-order.js";

await migrate();
const marker = `${Date.now()}-${Math.floor(Math.random()*10000)}`;
const accountBase = BigInt(Date.now())*100n;
const actor = () => ({ actor_id: "phase-b5.4-e2e", request_id: randomUUID() });
async function tenant(suffix:string, offset:number) {
  const id=`phase-b5-4-${marker}-${suffix}`;
  await pool.query(`INSERT INTO tenants(tenant_id,name,status,chatwoot_account_id,signup_source) VALUES($1,$1,'test',$2,'synthetic-phase-b5.4')`,[id,(accountBase+BigInt(offset)).toString()]);
  return id;
}
const first=await tenant("a",1), second=await tenant("b",2);
async function order(tenantId:string,suffix:string){return createPaymentOrder(tenantId,{idempotency_key:`${marker}-${suffix}`,product_code:"pro.monthly",provider:"synthetic",currency:"CNY",amount_minor:10000},actor())}
const pending=await order(first,"pending"), paid=await order(first,"paid"), refunded=await order(first,"refunded");
await order(second,"isolated");
for(const item of [paid,refunded]) await recordSyntheticPaymentEvent(first,item.payment_order_id,{provider_event_id:`paid-${item.payment_order_id}`,event_type:"payment_succeeded",amount_minor:10000,currency:"CNY",occurred_at:new Date().toISOString()},actor());
await recordSyntheticPaymentEvent(first,refunded.payment_order_id,{provider_event_id:`refund-${refunded.payment_order_id}`,event_type:"payment_refunded",amount_minor:2500,currency:"CNY",occurred_at:new Date(Date.now()+1000).toISOString()},actor());
await Promise.all(Array.from({length:4},()=>processPaymentLedgerOutbox(20)));
const overview=await paymentOperationsOverview(first,30);
assert.deepEqual({created:overview.created_orders,settled:overview.settled_orders,pending:overview.pending_orders,gross:overview.gross_minor,refunded:overview.refunded_minor,net:overview.net_minor},{created:3,settled:2,pending:1,gross:"20000",refunded:"2500",net:"17500"});
assert.equal(overview.conversion_rate,66.67);
assert.deepEqual(overview.projection,{pending:0,dead:0,oldest_pending_seconds:0});
const page=await listPaymentOrders(first,{page:1,limit:2});
assert.equal(page.data.length,2); assert.equal(page.pagination.has_next,true);
const expectedIds=new Set([pending.payment_order_id,paid.payment_order_id,refunded.payment_order_id]);
assert.ok(page.data.every(item=>expectedIds.has(item.payment_order_id)));
const nextPage=await listPaymentOrders(first,{page:2,limit:2});
assert.equal(nextPage.data.length,1); assert.equal(nextPage.pagination.has_next,false); assert.ok(expectedIds.has(nextPage.data[0].payment_order_id));
assert.ok(!page.data.some(item=>item.payment_order_id===nextPage.data[0].payment_order_id));
const filtered=await listPaymentOrders(first,{page:1,limit:10,status:"pending_payment"});
assert.equal(filtered.data.length,1); assert.equal(filtered.data[0].payment_order_id,pending.payment_order_id);
assert.equal((await listPaymentOrders(second,{page:1,limit:10})).data.length,1);
await assert.rejects(()=>listPaymentOrders(first,{page:1,limit:10,status:"unknown"}));
console.log(`phase_b5_4_e2e=ok marker=${marker} tenant_isolation=true pagination=true status_filter=true funnel=true projection_observability=true`);
await pool.end();
