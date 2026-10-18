import * as SmsSdk from "@alicloud/dysmsapi20170525";
import type { ProviderDiagnostic } from "./mail-provider.js";
import { secretValue } from "./secret-value.js";

export type SmsProviderName = "mock" | "aliyun";
export type SmsDelivery = { provider: SmsProviderName; message_id: string; accepted: boolean };
export type SmsFailureCategory = "configuration" | "authentication" | "template_or_signature" | "rate_limit" | "invalid_recipient" | "account_balance" | "transient" | "provider_rejected" | "unknown";
export type SmsFailureDetails = { provider_code: string; category: SmsFailureCategory; retryable: boolean };

export class SmsProviderError extends Error {
  constructor(message: string, public readonly details: SmsFailureDetails) { super(message); this.name = "SmsProviderError"; }
}
type AliyunSmsClient = { sendSms(request: InstanceType<typeof SmsSdk.SendSmsRequest>): Promise<{ body?: { code?: string; bizId?: string; requestId?: string } }> };
type AliyunSmsClientConstructor = new (config: Record<string, unknown>) => AliyunSmsClient;

function aliyunClientConstructor(): AliyunSmsClientConstructor {
  const exported = SmsSdk.default as unknown as AliyunSmsClientConstructor | { default: AliyunSmsClientConstructor };
  return typeof exported === "function" ? exported : exported.default;
}

function provider(): SmsProviderName {
  const value = process.env.SMS_PROVIDER ?? "mock";
  if (!["mock", "aliyun"].includes(value)) throw new Error(`Unsupported SMS_PROVIDER: ${value}`);
  return value as SmsProviderName;
}

function missing(names: string[]): string[] { return names.filter(name => !secretValue(name)); }

function safeProviderCode(value: unknown): string {
  const text = typeof value === "string" ? value : "unknown";
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(text) ? text : "unknown";
}

export function classifySmsProviderFailure(codeValue: unknown): SmsFailureDetails {
  const provider_code = safeProviderCode(codeValue), code = provider_code.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (code.includes("missing") || code.includes("configuration") || code.includes("disabled")) return { provider_code, category: "configuration", retryable: false };
  if (code.includes("forbidden") || code.includes("signaturedoesnotmatch") || code.includes("invalidaccesskey") || code.includes("unauthorized")) return { provider_code, category: "authentication", retryable: false };
  if (code.includes("template") || code.includes("signname") || code.includes("signatureillegal")) return { provider_code, category: "template_or_signature", retryable: false };
  if (code.includes("businesslimitcontrol") || code.includes("ratelimit") || code.includes("throttl")) return { provider_code, category: "rate_limit", retryable: true };
  if (code.includes("mobilenumberillegal") || code.includes("phonenumber") || code.includes("invalidrecipient")) return { provider_code, category: "invalid_recipient", retryable: false };
  if (code.includes("amountnotenough") || code.includes("balance")) return { provider_code, category: "account_balance", retryable: false };
  if (code.includes("timeout") || code.includes("network") || code.includes("serviceunavailable") || code.includes("internalerror")) return { provider_code, category: "transient", retryable: true };
  return { provider_code, category: provider_code === "unknown" ? "unknown" : "provider_rejected", retryable: false };
}

export function smsFailureDetails(error: unknown): SmsFailureDetails {
  if (error instanceof SmsProviderError) return error.details;
  const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return classifySmsProviderFailure(candidate.code ?? candidate.name ?? "unknown");
}

export function smsProviderDiagnostic(): ProviderDiagnostic {
  const selected = provider();
  if (selected === "mock") return { provider: selected, configured: true, live_send_enabled: false, missing: [], endpoint: "local://mock-sms" };
  const absent = missing(["ALIYUN_SMS_ACCESS_KEY_ID", "ALIYUN_SMS_ACCESS_KEY_SECRET", "ALIYUN_SMS_SIGN_NAME", "ALIYUN_SMS_TEMPLATE_CODE"]);
  return { provider: selected, configured: absent.length === 0, live_send_enabled: process.env.SMS_LIVE_SEND_ENABLED === "true", missing: absent, endpoint: process.env.ALIYUN_SMS_ENDPOINT ?? "dysmsapi.aliyuncs.com" };
}

export function normalizeMainlandPhone(value: string): string | undefined {
  const normalized = value.replace(/[\s-]/g, "").replace(/^\+86/, "").replace(/^0086/, "").replace(/^86(?=1)/, "");
  return /^1[3-9]\d{9}$/.test(normalized) ? normalized : undefined;
}

export async function sendVerificationSms(phone: string, code: string): Promise<SmsDelivery> {
  const normalized = normalizeMainlandPhone(phone);
  if (!normalized || !/^\d{6}$/.test(code)) throw new Error("Invalid phone or verification code");
  const selected = provider();
  if (selected === "mock") return { provider: selected, message_id: `mock-${Date.now()}`, accepted: true };
  const diagnostic = smsProviderDiagnostic();
  if (!diagnostic.configured) throw new SmsProviderError("SMS provider configuration is incomplete", classifySmsProviderFailure("configuration_missing"));
  if (!diagnostic.live_send_enabled) throw new SmsProviderError("SMS live delivery is disabled", classifySmsProviderFailure("live_delivery_disabled"));
  const Client = aliyunClientConstructor();
  const client = new Client({
    accessKeyId: secretValue("ALIYUN_SMS_ACCESS_KEY_ID")!,
    accessKeySecret: secretValue("ALIYUN_SMS_ACCESS_KEY_SECRET")!,
    endpoint: process.env.ALIYUN_SMS_ENDPOINT ?? "dysmsapi.aliyuncs.com",
    type: "access_key",
    regionId: process.env.ALIYUN_SMS_REGION_ID ?? "cn-hangzhou"
  });
  let result: Awaited<ReturnType<AliyunSmsClient["sendSms"]>>;
  try {
    result = await client.sendSms(new SmsSdk.SendSmsRequest({
      phoneNumbers: normalized,
      signName: secretValue("ALIYUN_SMS_SIGN_NAME")!,
      templateCode: secretValue("ALIYUN_SMS_TEMPLATE_CODE")!,
      templateParam: JSON.stringify({ code })
    }));
  } catch (error) {
    const details = smsFailureDetails(error);
    throw new SmsProviderError("SMS provider request failed", details);
  }
  const body = result.body;
  if (body?.code !== "OK") throw new SmsProviderError("SMS provider rejected request", classifySmsProviderFailure(body?.code));
  return { provider: selected, message_id: body.bizId ?? body.requestId ?? "accepted", accepted: true };
}
