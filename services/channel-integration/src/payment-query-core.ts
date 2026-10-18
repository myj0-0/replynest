export type PaymentQueryResult = {
  state: "pending" | "paid" | "closed" | "unknown";
  provider: "wechat_pay" | "alipay";
  merchant_order_number: string;
  provider_order_id?: string;
  provider_transaction_id?: string;
  amount_minor?: number;
  currency?: string;
  paid_at?: string;
};

export type PaymentQueryOrder = {
  provider: "wechat_pay" | "alipay";
  order_number: string;
  provider_order_id?: string | null;
  amount_minor: number;
  currency: string;
  payment_mode?: string;
  expires_at?: string;
};

export function paymentQueryRetryDelaySeconds(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("invalid_query_attempt");
  return Math.min(3600, 30 * 2 ** Math.min(attempt - 1, 7));
}

export function validatePaymentQueryResult(order: PaymentQueryOrder, result: PaymentQueryResult): PaymentQueryResult {
  if (result.provider !== order.provider) throw new Error("query_provider_mismatch");
  if (result.merchant_order_number !== order.order_number) throw new Error("query_order_number_mismatch");
  if (order.provider_order_id && result.provider_order_id && result.provider_order_id !== order.provider_order_id) throw new Error("query_provider_order_mismatch");
  if (result.state === "paid") {
    if (result.amount_minor !== order.amount_minor) throw new Error("query_amount_mismatch");
    if (result.currency !== order.currency) throw new Error("query_currency_mismatch");
    if (!result.provider_transaction_id || !result.paid_at || Number.isNaN(Date.parse(result.paid_at))) throw new Error("query_paid_facts_incomplete");
  }
  return result;
}

export function paymentQueryEventId(result: PaymentQueryResult): string {
  if (result.state !== "paid" || !result.provider_transaction_id) throw new Error("query_result_not_paid");
  return `query:${result.provider}:${result.provider_transaction_id}`;
}
