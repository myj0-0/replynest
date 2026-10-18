import { secretValue } from "./secret-value.js";

export type PaymentProvider = "disabled" | "wechat_pay" | "alipay" | "invalid";
export type PaymentDiagnostics = { provider: PaymentProvider; enabled: boolean; configured: boolean; missing: string[]; mode: "sandbox" | "live" };

const value = (name: string) => {
  try { return Boolean(secretValue(name)); } catch { return false; }
};
export function paymentDiagnostics(): PaymentDiagnostics {
  const raw = (process.env.PAYMENT_PROVIDER ?? "disabled").trim().toLowerCase();
  const provider: PaymentProvider = raw === "disabled" || raw === "wechat_pay" || raw === "alipay" ? raw : "invalid";
  const enabled = (provider === "wechat_pay" || provider === "alipay") && process.env.PAYMENT_LIVE_ENABLED === "true";
  const required = provider === "wechat_pay"
    ? ["WECHAT_PAY_MCH_ID", "WECHAT_PAY_SERIAL_NO", "WECHAT_PAY_PRIVATE_KEY", "WECHAT_PAY_API_V3_KEY"]
    : provider === "alipay" ? ["ALIPAY_APP_ID", "ALIPAY_SELLER_ID", "ALIPAY_PRIVATE_KEY", "ALIPAY_PUBLIC_KEY", "ALIPAY_NOTIFY_URL", "ALIPAY_RETURN_URL"] : provider === "invalid" ? ["PAYMENT_PROVIDER"] : [];
  const missing = provider === "invalid" ? ["PAYMENT_PROVIDER"] : required.filter(name => !value(name));
  return { provider, enabled, configured: provider === "disabled" || (provider !== "invalid" && missing.length === 0), missing, mode: process.env.PAYMENT_MODE === "live" ? "live" : "sandbox" };
}

export function assertPaymentReady(): PaymentDiagnostics {
  const diagnostics = paymentDiagnostics();
  if (!diagnostics.enabled) throw new Error("payment_provider_disabled");
  if (!diagnostics.configured) throw new Error(`payment_provider_not_configured:${diagnostics.missing.join(",")}`);
  return diagnostics;
}
