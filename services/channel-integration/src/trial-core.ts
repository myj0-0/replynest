export type TrialGrant = { account: "gift" | "ai_credit"; currency: string; amount_minor: number };
export type TrialBenefit = {
  plan_code?: 'starter'|'professional'; plan_name?:string; plan_version?:number; entitlement_snapshot?:Record<string,unknown>;
  trial_days: number; grace_days: number; seat_limit: number; message_limit: number;
  knowledge_bytes: number; features: string[]; grants: TrialGrant[];
};
export type TrialSignals = {
  has_verified_contact: boolean; prior_trial: boolean; shared_admin: boolean;
  shared_verified_phone: boolean; shared_organization: boolean;
  risk_state: "clear" | "review" | "blocked";
};
export type TrialOutcome = "eligible" | "review" | "rejected";

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown, name: string, maximum: number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) throw new Error(`invalid trial ${name}`);
  return parsed;
}

export function validateTrialBenefit(raw: unknown): TrialBenefit {
  if (!object(raw)) throw new Error("invalid trial benefit rule");
  const features = raw.features;
  const grants = raw.grants;
  if (!Array.isArray(features) || features.length > 50 || features.some(item => typeof item !== "string" || !/^[a-z0-9._-]{1,64}$/.test(item))) {
    throw new Error("invalid trial features");
  }
  if (!Array.isArray(grants) || grants.length > 10) throw new Error("invalid trial grants");
  const parsedGrants = grants.map(item => {
    if (!object(item) || !["gift", "ai_credit"].includes(String(item.account)) || !/^[A-Z]{3}$/.test(String(item.currency))) {
      throw new Error("invalid trial grant");
    }
    return {
      account: String(item.account) as TrialGrant["account"], currency: String(item.currency),
      amount_minor: positiveInteger(item.amount_minor, "grant amount", Number.MAX_SAFE_INTEGER),
    };
  });
  const unique = new Set(parsedGrants.map(item => `${item.account}:${item.currency}`));
  if (unique.size !== parsedGrants.length) throw new Error("duplicate trial grant account and currency");
  return {
    ...(raw.plan_code=== 'starter'||raw.plan_code==='professional'?{plan_code:raw.plan_code,plan_name:String(raw.plan_name??raw.plan_code),plan_version:Number(raw.plan_version??1),...(object(raw.entitlement_snapshot)?{entitlement_snapshot:raw.entitlement_snapshot}:{})}:{}),
    trial_days: positiveInteger(raw.trial_days, "days", 365),
    grace_days: positiveInteger(raw.grace_days, "grace days", 90),
    seat_limit: positiveInteger(raw.seat_limit, "seat limit", 10_000),
    message_limit: positiveInteger(raw.message_limit, "message limit", 1_000_000_000),
    knowledge_bytes: positiveInteger(raw.knowledge_bytes, "knowledge limit", Number.MAX_SAFE_INTEGER),
    features: [...new Set(features as string[])], grants: parsedGrants,
  };
}

export function decideTrialEligibility(signals: TrialSignals): { outcome: TrialOutcome; reason_codes: string[] } {
  const reasons: string[] = [];
  if (signals.prior_trial) reasons.push("trial_already_used");
  if (signals.shared_admin) reasons.push("admin_used_trial_elsewhere");
  if (signals.shared_verified_phone) reasons.push("verified_phone_used_trial_elsewhere");
  if (signals.shared_organization) reasons.push("organization_used_trial_elsewhere");
  if (signals.risk_state === "blocked") reasons.push("risk_blocked");
  if (reasons.length) return { outcome: "rejected", reason_codes: reasons };
  if (!signals.has_verified_contact) return { outcome: "rejected", reason_codes: ["verified_contact_required"] };
  if (signals.risk_state === "review") return { outcome: "review", reason_codes: ["risk_review_required"] };
  return { outcome: "eligible", reason_codes: ["new_verified_tenant"] };
}

export function trialWindow(start: Date, benefit: TrialBenefit) {
  if (!Number.isFinite(start.getTime())) throw new Error("invalid trial start time");
  const endsAt = new Date(start.getTime() + benefit.trial_days * 86_400_000);
  return { starts_at: start.toISOString(), ends_at: endsAt.toISOString(), grace_ends_at: new Date(endsAt.getTime() + benefit.grace_days * 86_400_000).toISOString() };
}
