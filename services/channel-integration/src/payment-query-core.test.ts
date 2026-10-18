import test from "node:test";
import assert from "node:assert/strict";
import { paymentQueryEventId, paymentQueryRetryDelaySeconds, validatePaymentQueryResult } from "./payment-query-core.js";

const order = { provider: "wechat_pay" as const, order_number: "RN20260912ABCDEF123456", provider_order_id: null, amount_minor: 9900, currency: "CNY" };

test("payment query retry is exponential and capped", () => {
  assert.equal(paymentQueryRetryDelaySeconds(1), 30);
  assert.equal(paymentQueryRetryDelaySeconds(4), 240);
  assert.equal(paymentQueryRetryDelaySeconds(20), 3600);
});

test("paid query result must match immutable order facts", () => {
  const valid = validatePaymentQueryResult(order, { state: "paid", provider: "wechat_pay", merchant_order_number: order.order_number, provider_transaction_id: "tx-1", amount_minor: 9900, currency: "CNY", paid_at: "2026-09-12T01:00:00Z" });
  assert.equal(paymentQueryEventId(valid), "query:wechat_pay:tx-1");
  assert.throws(() => validatePaymentQueryResult(order, { ...valid, amount_minor: 1 }), /query_amount_mismatch/);
  assert.throws(() => validatePaymentQueryResult(order, { ...valid, merchant_order_number: "other" }), /query_order_number_mismatch/);
});

test("pending query result does not invent settlement facts", () => {
  const result = validatePaymentQueryResult(order, { state: "pending", provider: "wechat_pay", merchant_order_number: order.order_number });
  assert.equal(result.state, "pending");
  assert.throws(() => paymentQueryEventId(result), /query_result_not_paid/);
});
