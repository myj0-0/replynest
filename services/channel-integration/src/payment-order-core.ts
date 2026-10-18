import { createHash } from "node:crypto";

export const paymentOrderStatuses = ["pending_payment", "paid", "partially_refunded", "refunded", "chargeback", "cancelled"] as const;
export const paymentEventTypes = ["payment_succeeded", "payment_refunded", "payment_chargeback", "payment_cancelled"] as const;
export type PaymentOrderStatus = typeof paymentOrderStatuses[number];
export type PaymentEventType = typeof paymentEventTypes[number];
export type PaymentOrderFacts = { status: PaymentOrderStatus; amount_minor: number; refunded_minor: number };
export type PaymentTransition = { outcome: "applied" | "deferred" | "ignored"; next_status: PaymentOrderStatus; next_refunded_minor: number; reason: string };

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export function validatePaymentOrderInput(raw: unknown) {
  if (!object(raw)) throw new Error("payment order input must be an object");
  const idempotency_key = String(raw.idempotency_key ?? "").trim();
  const product_code = String(raw.product_code ?? "").trim();
  const provider = String(raw.provider ?? "").trim();
  const currency = String(raw.currency ?? "").trim().toUpperCase();
  const amount_minor = Number(raw.amount_minor);
  if (!idempotency_key || idempotency_key.length > 128) throw new Error("invalid payment order idempotency key");
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(product_code)) throw new Error("invalid product code");
  if (!["synthetic", "wechat_pay", "alipay"].includes(provider)) throw new Error("invalid payment provider");
  if (currency !== "CNY") throw new Error("only CNY is supported in phase B.5");
  if (!Number.isSafeInteger(amount_minor) || amount_minor <= 0) throw new Error("invalid payment amount");
  return { idempotency_key, product_code, provider, currency, amount_minor };
}

export function paymentOrderRequestHash(input: ReturnType<typeof validatePaymentOrderInput>) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function applyPaymentEvent(order: PaymentOrderFacts, type: PaymentEventType, amountMinor: number): PaymentTransition {
  if (!paymentOrderStatuses.includes(order.status) || !Number.isSafeInteger(order.amount_minor) || order.amount_minor <= 0 || !Number.isSafeInteger(order.refunded_minor) || order.refunded_minor < 0) throw new Error("invalid payment order facts");
  if (!paymentEventTypes.includes(type) || !Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error("invalid payment event");
  if (type === "payment_succeeded") {
    if (amountMinor !== order.amount_minor) return { outcome: "ignored", next_status: order.status, next_refunded_minor: order.refunded_minor, reason: "settled_amount_mismatch" };
    if (order.status === "paid" || order.status === "partially_refunded" || order.status === "refunded" || order.status === "chargeback") return { outcome: "ignored", next_status: order.status, next_refunded_minor: order.refunded_minor, reason: "payment_already_settled" };
    return { outcome: "applied", next_status: "paid", next_refunded_minor: 0, reason: "payment_settled" };
  }
  if (type === "payment_cancelled") {
    if (order.status !== "pending_payment") return { outcome: "ignored", next_status: order.status, next_refunded_minor: order.refunded_minor, reason: "settled_order_cannot_be_cancelled" };
    return { outcome: "applied", next_status: "cancelled", next_refunded_minor: 0, reason: "payment_cancelled" };
  }
  if (order.status === "pending_payment" || order.status === "cancelled") return { outcome: "deferred", next_status: order.status, next_refunded_minor: order.refunded_minor, reason: "settlement_event_not_received" };
  if (order.status === "refunded" || order.status === "chargeback") return { outcome: "ignored", next_status: order.status, next_refunded_minor: order.refunded_minor, reason: "terminal_payment_state" };
  if (type === "payment_chargeback") return { outcome: "applied", next_status: "chargeback", next_refunded_minor: order.amount_minor, reason: "payment_chargeback" };
  const remaining = order.amount_minor - order.refunded_minor;
  if (amountMinor <= 0 || amountMinor > remaining) return { outcome: "ignored", next_status: order.status, next_refunded_minor: order.refunded_minor, reason: "invalid_refund_amount" };
  const refunded = order.refunded_minor + amountMinor;
  return { outcome: "applied", next_status: refunded === order.amount_minor ? "refunded" : "partially_refunded", next_refunded_minor: refunded, reason: refunded === order.amount_minor ? "payment_refunded" : "payment_partially_refunded" };
}
