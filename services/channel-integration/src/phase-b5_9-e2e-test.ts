import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrate, pool } from "./database.js";
import { processPaymentQueries, schedulePaymentQueries } from "./payment-query.js";
import { createPaymentOrder } from "./payment-order.js";

process.env.PAYMENT_ORDER_QUERY_ENABLED = "true";
process.env.PAYMENT_ORDER_QUERY_INTERVAL_SECONDS = "60";
await migrate();
const marker = `${Date.now()}-${Math.floor(Math.random()*10000)}`;
const tenantId = `phase-b5-9-${marker}`;
await pool.query(`INSERT INTO tenants(tenant_id,name,status,chatwoot_account_id,signup_source) VALUES($1,$1,'test',$2,'synthetic-phase-b5.9')`, [tenantId, (BigInt(Date.now())*100n).toString()]);
const actor = { actor_id: "phase-b5.9-e2e", request_id: randomUUID() };
const order = await createPaymentOrder(tenantId, { idempotency_key: marker, product_code: "pro.monthly", provider: "wechat_pay", currency: "CNY", amount_minor: 9900 }, actor);
await pool.query(`UPDATE payment_orders SET created_at=NOW()-INTERVAL '2 minutes' WHERE payment_order_id=$1`, [order.payment_order_id]);
assert.equal(await schedulePaymentQueries(), 1);
assert.equal(await schedulePaymentQueries(), 0);

const paidAdapter = { query: async (input: any) => ({ state: "paid" as const, provider: "wechat_pay" as const, merchant_order_number: input.order_number, provider_transaction_id: `tx-${marker}`, amount_minor: 9900, currency: "CNY", paid_at: new Date().toISOString() }) };
const processed = await processPaymentQueries({ wechat_pay: paidAdapter });
assert.deepEqual(processed, { claimed: 1, succeeded: 1, failed: 0 });
const paid = await pool.query(`SELECT status FROM payment_orders WHERE payment_order_id=$1`, [order.payment_order_id]);
assert.equal(paid.rows[0].status, "paid");
assert.equal(Number((await pool.query(`SELECT COUNT(*) FROM payment_events WHERE payment_order_id=$1`, [order.payment_order_id])).rows[0].count), 1);
assert.equal(Number((await pool.query(`SELECT COUNT(*) FROM payment_ledger_outbox WHERE payment_order_id=$1`, [order.payment_order_id])).rows[0].count), 1);

const retryOrder = await createPaymentOrder(tenantId, { idempotency_key: `${marker}-retry`, product_code: "pro.monthly", provider: "alipay", currency: "CNY", amount_minor: 8800 }, actor);
const retryJob = await pool.query<{query_job_id:string}>(`INSERT INTO payment_order_query_jobs(tenant_id,payment_order_id,provider,slot_started_at,max_attempts) VALUES($1,$2,'alipay',NOW(),2) RETURNING query_job_id`, [tenantId, retryOrder.payment_order_id]);
const failedAdapter = { query: async () => { throw new Error("provider_network_error"); } };
assert.deepEqual(await processPaymentQueries({ alipay: failedAdapter }), { claimed: 1, succeeded: 0, failed: 1 });
assert.equal((await pool.query(`SELECT status FROM payment_order_query_jobs WHERE query_job_id=$1`, [retryJob.rows[0].query_job_id])).rows[0].status, "retry_pending");
await pool.query(`UPDATE payment_order_query_jobs SET available_at=NOW() WHERE query_job_id=$1`, [retryJob.rows[0].query_job_id]);
await processPaymentQueries({ alipay: failedAdapter });
assert.equal((await pool.query(`SELECT status FROM payment_order_query_jobs WHERE query_job_id=$1`, [retryJob.rows[0].query_job_id])).rows[0].status, "dead");
await pool.query(`UPDATE payment_order_query_jobs SET status='succeeded',result_state='unknown',last_error_code=NULL,completed_at=NOW() WHERE query_job_id=$1`, [retryJob.rows[0].query_job_id]);

console.log(`phase_b5_9_e2e=ok marker=${marker} dedupe=true paid_event=true ledger_outbox=true bounded_retry=true dead_letter=true`);
await pool.end();
