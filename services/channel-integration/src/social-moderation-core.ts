import { decideSocialRoute, socialCategories, type SocialCategory, type SocialEventType } from "./social-channel-core.js";

export const correctableSocialCategories = socialCategories.filter(category => category !== "unknown") as Array<Exclude<SocialCategory, "unknown">>;
export type CorrectableSocialCategory = (typeof correctableSocialCategories)[number];
export type SocialCaseState = "pending" | "acknowledged" | "resolved";
export type SocialCaseAction = "acknowledge" | "resolve" | "reopen";
export const socialQualityWindows = [7, 30, 90] as const;
export type SocialQualityWindow = (typeof socialQualityWindows)[number];

export function validateSocialRuleName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (name.length < 2 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("invalid_social_rule_name");
  return name;
}

export function validateCorrectableCategory(value: unknown): CorrectableSocialCategory {
  if (!correctableSocialCategories.includes(value as CorrectableSocialCategory)) throw new Error("invalid_social_correction_category");
  return value as CorrectableSocialCategory;
}

export function validateModerationReason(value: unknown): string {
  const reason = String(value ?? "").trim();
  if (reason.length < 10 || reason.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) {
    throw new Error("invalid_social_moderation_reason");
  }
  return reason;
}

export function validateSocialQualityWindow(value: unknown): SocialQualityWindow {
  const days = Number(value ?? 30);
  if (!socialQualityWindows.includes(days as SocialQualityWindow)) throw new Error("invalid_social_quality_window");
  return days as SocialQualityWindow;
}

export function socialObservedRate(numerator: number, denominator: number): number | null {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator < 0 || denominator < 0 || numerator > denominator) {
    throw new Error("invalid_social_quality_counts");
  }
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;
}

export function correctedSocialRoute(eventType: SocialEventType, category: CorrectableSocialCategory) {
  return decideSocialRoute(eventType, {
    category,
    confidence: 1,
    source: "deterministic",
    reason_codes: ["human_correction"],
    matched_rule_id: null,
  });
}

export function nextSocialCaseState(current: SocialCaseState, action: SocialCaseAction): SocialCaseState {
  if (action === "acknowledge" && current === "pending") return "acknowledged";
  if (action === "resolve" && (current === "pending" || current === "acknowledged")) return "resolved";
  if (action === "reopen" && current === "resolved") return "pending";
  throw new Error("invalid_social_case_transition");
}
