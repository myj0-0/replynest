import { gatewayUrl } from "./console-session";

export type BillingBalance = { account: "cash" | "gift" | "referral" | "ai_credit"; balance_minor: string };
export type BillingTransaction = { transaction_id: string; transaction_type: string; currency: string; source_type: string; source_id: string; reversal_of: string | null; tenant_balance_delta_minor: string; occurred_at: string; posted_at: string };
export type PaymentOrder = { payment_order_id: string; order_number: string; product_code: string; provider: string; provider_order_id: string | null; currency: string; amount_minor: string; refunded_minor: string; status: string; paid_at: string | null; closed_at: string | null; created_at: string; refund_request?:{status:string;amount_minor:string}|null; fulfillment?: {status:string;period_end:string|null;review_reason:string|null;payment_mode:string}|null; projection_count: number; projected_count: number; projection_dead_count: number };
export type PaymentOverview = { window_days: number; created_orders: number; settled_orders: number; pending_orders: number; cancelled_orders: number; affected_by_refund_orders: number; conversion_rate: number; currency: string; gross_minor: string; refunded_minor: string; net_minor: string; projection: { pending: number; dead: number; oldest_pending_seconds: number } };
export type EntitlementRules={seat_limit:number|null;channel_limit:number|null;customer_limit:number|null;ai_actions_monthly:number|null;knowledge_bytes:number|null;automation_rule_limit:number|null;qr_code_limit:number|null;audit_retention_days:number|null;features:string[]};
export type PlanCatalogItem={plan_version_id:string;plan_code:"free"|"starter"|"professional"|"enterprise";name:string;version:number;billing_period:string;price_minor:string|null;list_price_minor?:string|null;annual_price_minor?:string|null;currency:string;entitlement_rules:EntitlementRules};
export type SubscriptionOverview={plan:{code:string;name:string;version:number};source:string;subscription:Record<string,unknown>;entitlements:EntitlementRules;usage:{active_seats:number;channels:number;customers:number;knowledge_bytes:string;ai_actions_monthly:string;period_start:string;period_end:string}};

export async function fetchBilling(token: string) {
  try {
    const [plansResponse,pointsResponse,subscriptionResponse] = await Promise.all([
      fetch(gatewayUrl("/api/v1/billing/plans"), { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(8_000) }),
      fetch(gatewayUrl("/api/v1/billing/ai-points?view=summary"), { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(8_000) }),
      fetch(gatewayUrl("/api/v1/billing/subscription"), { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(8_000) }),
    ]);
    if (!plansResponse.ok || !subscriptionResponse.ok) return undefined;
    const plans = await plansResponse.json() as { data: PlanCatalogItem[] };
    const subscription = await subscriptionResponse.json() as { data: SubscriptionOverview };
    const aiPoints=pointsResponse.ok?(await pointsResponse.json()).data as {enabled:boolean;monthly_used_micros:number;monthly_limit_micros:number|null}:undefined;
    return { plans:plans.data,subscription:subscription.data,aiPoints };
  } catch { return undefined; }
}

export function formatMinor(value: string, currency = "CNY") {
  const amount = Number(value) / 100;
  if(currency==='AIC') return `${new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(Number.isFinite(amount)?amount:0)} AI 点数`;
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency, minimumFractionDigits: 2 }).format(Number.isFinite(amount) ? amount : 0);
}
