import { createHmac } from "node:crypto";

export const riskSignalTypes = ["verified_phone", "legal_entity", "wechat_official_account", "payment_subject", "device", "ip_network"] as const;
export type RiskSignalType = typeof riskSignalTypes[number];
export type RiskMatch = { signal_type: RiskSignalType; confidence: "high" | "medium" | "low" };

export function normalizeRiskSignal(type: RiskSignalType, raw: unknown) {
  if (!riskSignalTypes.includes(type)) throw new Error("invalid risk signal type");
  let value = String(raw ?? "").trim();
  if (type === "verified_phone") value = value.replace(/[\s()-]/g, "");
  else if (type === "legal_entity") value = value.replace(/\s/g, "").toUpperCase();
  else value = value.toLowerCase();
  if (value.length < 3 || value.length > 256) throw new Error("invalid risk signal value");
  return value;
}

export function riskSignalFingerprint(type: RiskSignalType, raw: unknown, pepper: string) {
  if (pepper.length < 32) throw new Error("risk signal pepper must contain at least 32 characters");
  return createHmac("sha256", pepper).update(`${type}\0${normalizeRiskSignal(type, raw)}`).digest("hex");
}

export function signalConfidence(type: RiskSignalType): RiskMatch["confidence"] {
  if (["verified_phone", "legal_entity", "wechat_official_account", "payment_subject"].includes(type)) return "high";
  return type === "device" ? "medium" : "low";
}

export function assessReferralRisk(matches: RiskMatch[]) {
  const types = new Set(matches.map(item => item.signal_type));
  const high = matches.some(item => item.confidence === "high");
  const medium = matches.some(item => item.confidence === "medium");
  const low = matches.some(item => item.confidence === "low");
  if (high) return { outcome: "reject" as const, risk_score: 100, reason_codes: ["high_confidence_identity_match"] };
  if (medium) return { outcome: "review" as const, risk_score: low ? 75 : 60, reason_codes: ["linked_device_requires_review", ...(low ? ["shared_network_observed"] : [])] };
  if (low) return { outcome: "allow" as const, risk_score: 20, reason_codes: ["shared_network_observed"] };
  return { outcome: "allow" as const, risk_score: 0, reason_codes: ["risk_check_clear"] };
}
