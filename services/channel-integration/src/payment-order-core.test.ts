import test from "node:test";
import assert from "node:assert/strict";
import { applyPaymentEvent, paymentOrderRequestHash, validatePaymentOrderInput } from "./payment-order-core.js";

test("payment order validation is deterministic and CNY-only", () => {
  const input = validatePaymentOrderInput({ idempotency_key: "order-1", product_code: "pro.monthly", provider: "synthetic", currency: "cny", amount_minor: 9900 });
  assert.equal(paymentOrderRequestHash(input), paymentOrderRequestHash({ ...input }));
  assert.throws(() => validatePaymentOrderInput({ ...input, currency: "USD" }));
  assert.throws(() => validatePaymentOrderInput({ ...input, amount_minor: 9.9 }));
});

test("out-of-order refund is deferred and settlement can arrive after cancellation", () => {
  const pending = { status: "pending_payment" as const, amount_minor: 9900, refunded_minor: 0 };
  assert.equal(applyPaymentEvent(pending, "payment_refunded", 9900).outcome, "deferred");
  const cancelled = applyPaymentEvent(pending, "payment_cancelled", 0);
  assert.equal(cancelled.next_status, "cancelled");
  assert.equal(applyPaymentEvent({ ...pending, status: "cancelled" }, "payment_succeeded", 9900).next_status, "paid");
});

test("partial and full refunds cannot exceed the settled amount", () => {
  const paid = { status: "paid" as const, amount_minor: 10000, refunded_minor: 0 };
  const partial = applyPaymentEvent(paid, "payment_refunded", 3000);
  assert.deepEqual(partial, { outcome: "applied", next_status: "partially_refunded", next_refunded_minor: 3000, reason: "payment_partially_refunded" });
  const full = applyPaymentEvent({ ...paid, status: partial.next_status, refunded_minor: partial.next_refunded_minor }, "payment_refunded", 7000);
  assert.equal(full.next_status, "refunded");
  assert.equal(applyPaymentEvent(paid, "payment_refunded", 10001).outcome, "ignored");
});

test("chargeback is terminal and mismatched settlement is ignored", () => {
  const paid = { status: "paid" as const, amount_minor: 10000, refunded_minor: 0 };
  assert.equal(applyPaymentEvent(paid, "payment_chargeback", 10000).next_status, "chargeback");
  assert.equal(applyPaymentEvent({ ...paid, status: "chargeback" }, "payment_refunded", 10000).outcome, "ignored");
  assert.equal(applyPaymentEvent({ ...paid, status: "pending_payment" }, "payment_succeeded", 9999).reason, "settled_amount_mismatch");
});
