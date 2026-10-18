export type ReferralRules = {
  inviter_billing_status: "paid"; min_account_age_days: number; min_lifetime_cash_paid_minor: number;
  attribution_window_minutes: number; min_first_cash_payment_minor: number; observation_days: number;
};
export type InviterFacts = { billing_status: string; account_age_days: number; lifetime_cash_paid_minor: number; risk_restricted: boolean; tenant_active?:boolean };

function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function integer(value: unknown, name: string, min: number, max: number) {
  const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`invalid referral ${name}`); return parsed;
}

export function validateReferralRules(raw: unknown): ReferralRules {
  if (!object(raw) || raw.inviter_billing_status !== "paid") throw new Error("invalid referral qualification rule");
  return {
    inviter_billing_status: "paid",
    min_account_age_days: integer(raw.min_account_age_days, "account age", 0, 3650),
    min_lifetime_cash_paid_minor: integer(raw.min_lifetime_cash_paid_minor, "cash paid threshold", 1, Number.MAX_SAFE_INTEGER),
    attribution_window_minutes: integer(raw.attribution_window_minutes, "attribution window", 1, 1440),
    min_first_cash_payment_minor: integer(raw.min_first_cash_payment_minor, "first payment threshold", 1, Number.MAX_SAFE_INTEGER),
    observation_days: integer(raw.observation_days, "observation period", 1, 180),
  };
}

export function inviterEligibility(facts: InviterFacts, rules: ReferralRules, partnerAuthorized=false) {
  const reasons: string[] = [];
  if (facts.billing_status !== rules.inviter_billing_status) reasons.push("paid_tenant_required");
  if (facts.account_age_days < rules.min_account_age_days) reasons.push("account_age_too_short");
  if (facts.lifetime_cash_paid_minor < rules.min_lifetime_cash_paid_minor) reasons.push("cash_spend_below_threshold");
  const waived=partnerAuthorized?[...reasons]:[];
  if(partnerAuthorized)reasons.length=0;
  if (facts.risk_restricted) reasons.push("inviter_risk_restricted");
  if(facts.tenant_active===false)reasons.push('inviter_tenant_inactive');
  return { eligible: reasons.length === 0, reason_codes: reasons,access_mode:partnerAuthorized?'partner':'standard',waived_reason_codes:waived };
}

export function paymentQualification(cashPaidMinor: number, currency: string, occurredAt: Date, rules: ReferralRules) {
  if (!Number.isSafeInteger(cashPaidMinor) || cashPaidMinor < 0 || currency !== "CNY" || !Number.isFinite(occurredAt.getTime())) throw new Error("invalid referral payment facts");
  if (cashPaidMinor < rules.min_first_cash_payment_minor) return { accepted: false, reason_codes: ["cash_payment_below_threshold"], observation_ends_at: null };
  return { accepted: true, reason_codes: ["first_cash_payment_settled"], observation_ends_at: new Date(occurredAt.getTime() + rules.observation_days * 86_400_000).toISOString() };
}

export function normalizeInviteCode(raw: unknown) {
  const code = String(raw ?? "").trim();
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(code)) throw new Error("invalid invite code");
  return code;
}
