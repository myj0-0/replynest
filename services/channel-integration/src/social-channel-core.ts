import { createHash } from "node:crypto";

export const socialProviders = ["douyin", "tiktok"] as const;
export type SocialProvider = typeof socialProviders[number];

export const socialEventTypes = ["dm.message", "comment.created", "comment.reply", "auth.revoked"] as const;
export type SocialEventType = typeof socialEventTypes[number];

export const socialCategories = [
  "spam",
  "generic_interaction",
  "purchase_intent",
  "pre_sale_question",
  "after_sales",
  "complaint_risk",
  "public_crisis",
  "unknown",
] as const;
export type SocialCategory = typeof socialCategories[number];

export type SocialCapability =
  | "dm_receive"
  | "dm_send"
  | "comment_list"
  | "comment_reply"
  | "comment_hide"
  | "comment_to_message"
  | "webhook"
  | "reply_window";

export type SocialCapabilitySnapshot = Record<SocialCapability, boolean> & {
  checked_at: string;
  source: "mock" | "provider" | "cached_provider";
};

export type NormalizedSocialEvent = {
  provider: SocialProvider;
  channel_connection_id: string;
  external_account_id: string;
  event_type: SocialEventType;
  external_event_id: string;
  external_user_id: string;
  content: string;
  video_id: string | null;
  comment_id: string | null;
  parent_comment_id: string | null;
  occurred_at: string;
  content_hash: string;
  metadata: Record<string, string | number | boolean | null>;
};

export type TenantSocialRule = {
  rule_id: string;
  priority: number;
  category: Exclude<SocialCategory, "unknown">;
  keywords: string[];
};

export type SocialClassification = {
  category: SocialCategory;
  confidence: number;
  source: "tenant_rule" | "deterministic" | "ai" | "fallback";
  reason_codes: string[];
  matched_rule_id: string | null;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idPattern = /^[A-Za-z0-9._:@/-]{1,200}$/;
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function requiredId(value: unknown, name: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || !idPattern.test(normalized)) throw new Error(`invalid_${name}`);
  return normalized;
}

function optionalId(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredId(value, name);
}

function normalizedContent(value: unknown, eventType: SocialEventType): string {
  const content = typeof value === "string" ? value.trim() : "";
  if (eventType === "auth.revoked") return "";
  if (!content || content.length > 5_000 || controlCharacters.test(content)) throw new Error("invalid_social_content");
  return content;
}

function normalizedOccurredAt(value: unknown, now: Date): string {
  const occurredAt = value === undefined ? now : new Date(String(value));
  if (!Number.isFinite(occurredAt.getTime())) throw new Error("invalid_occurred_at");
  if (occurredAt.getTime() > now.getTime() + 5 * 60_000 || occurredAt.getTime() < now.getTime() - 366 * 86_400_000) {
    throw new Error("invalid_occurred_at");
  }
  return occurredAt.toISOString();
}

function safeMetadata(value: unknown): Record<string, string | number | boolean | null> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_social_metadata");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) throw new Error("invalid_social_metadata");
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of entries) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) throw new Error("invalid_social_metadata");
    if (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") throw new Error("invalid_social_metadata");
    if (typeof item === "string" && item.length > 500) throw new Error("invalid_social_metadata");
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("invalid_social_metadata");
    output[key] = item;
  }
  return output;
}

export function normalizeSocialEvent(input: Record<string, unknown>, now = new Date()): NormalizedSocialEvent {
  if (!socialProviders.includes(input.provider as SocialProvider)) throw new Error("invalid_social_provider");
  if (!socialEventTypes.includes(input.event_type as SocialEventType)) throw new Error("invalid_social_event_type");
  const provider = input.provider as SocialProvider;
  const eventType = input.event_type as SocialEventType;
  const connectionId = requiredId(input.channel_connection_id, "channel_connection_id");
  if (!uuidPattern.test(connectionId)) throw new Error("invalid_channel_connection_id");
  const content = normalizedContent(input.content, eventType);
  const event = {
    provider,
    channel_connection_id: connectionId,
    external_account_id: requiredId(input.external_account_id, "external_account_id"),
    event_type: eventType,
    external_event_id: requiredId(input.external_event_id, "external_event_id"),
    external_user_id: requiredId(input.external_user_id, "external_user_id"),
    content,
    video_id: optionalId(input.video_id, "video_id"),
    comment_id: optionalId(input.comment_id, "comment_id"),
    parent_comment_id: optionalId(input.parent_comment_id, "parent_comment_id"),
    occurred_at: normalizedOccurredAt(input.occurred_at, now),
    metadata: safeMetadata(input.metadata),
  };
  if (eventType.startsWith("comment.") && (!event.video_id || !event.comment_id)) throw new Error("missing_comment_context");
  const contentHash = createHash("sha256").update(JSON.stringify(event)).digest("hex");
  return { ...event, content_hash: contentHash };
}

export function validateTenantSocialRules(rules: TenantSocialRule[]): TenantSocialRule[] {
  if (!Array.isArray(rules) || rules.length > 100) throw new Error("invalid_social_rules");
  const ids = new Set<string>();
  const normalized = rules.map(rule => {
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(rule.rule_id) || ids.has(rule.rule_id)) throw new Error("invalid_social_rule_id");
    ids.add(rule.rule_id);
    if (!Number.isSafeInteger(rule.priority) || rule.priority < 0 || rule.priority > 10_000) throw new Error("invalid_social_rule_priority");
    if (String(rule.category) === "unknown" || !socialCategories.includes(rule.category)) throw new Error("invalid_social_rule_category");
    if (!Array.isArray(rule.keywords) || rule.keywords.length < 1 || rule.keywords.length > 20) throw new Error("invalid_social_rule_keywords");
    const keywords = [...new Set(rule.keywords.map(item => item.trim().toLocaleLowerCase("zh-CN")))];
    if (keywords.some(item => item.length < 1 || item.length > 40 || controlCharacters.test(item))) throw new Error("invalid_social_rule_keywords");
    return { ...rule, keywords };
  });
  return normalized.sort((left, right) => right.priority - left.priority || left.rule_id.localeCompare(right.rule_id));
}

const patterns: Array<{ category: Exclude<SocialCategory, "unknown">; confidence: number; code: string; pattern: RegExp }> = [
  { category: "public_crisis", confidence: 0.96, code: "public_crisis_terms", pattern: /(媒体曝光|记者|热搜|全网曝光|监管通报|集体维权|\b(?:press|journalist|media exposure|go viral|regulator notice|class action)\b)/i },
  { category: "complaint_risk", confidence: 0.92, code: "complaint_terms", pattern: /(投诉|举报|消协|市场监管|欺诈|骗人|维权|\b(?:complaint|report this|report you|consumer authority|regulator|scam|fraud)\b)/i },
  { category: "after_sales", confidence: 0.9, code: "after_sales_terms", pattern: /(退款|退货|换货|坏了|破损|漏发|少发|没收到|售后|质量问题|订单异常|\b(?:refund|return|replacement|damaged|broken|missing item|never arrived|order issue|after[ -]?sales)\b)/i },
  { category: "purchase_intent", confidence: 0.88, code: "purchase_terms", pattern: /(怎么买|我要买|下单|购买链接|有货吗|库存|批发|采购|立即购买|\b(?:buy|purchase|place an order|purchase link|in stock|wholesale|buy this in bulk|bulk order)\b)/i },
  { category: "pre_sale_question", confidence: 0.84, code: "pre_sale_terms", pattern: /(多少钱|价格|优惠|型号|尺寸|适合|功能|保修多久|怎么选|\b(?:price|discount|model|size|feature|warranty|which plan|how to choose)\b)/i },
];

function looksLikeSpam(text: string): boolean {
  const urls = text.match(/https?:\/\//gi)?.length ?? 0;
  const contacts = text.match(/(?:加微|加v|vx|微信|qq)[:：\s]*[a-z0-9_-]{5,}/gi)?.length ?? 0;
  const repeated = /(.)\1{7,}/u.test(text);
  return urls >= 2 || contacts >= 2 || repeated;
}

function looksGeneric(text: string): boolean {
  const compact = text.replace(/[\p{P}\p{S}\s]/gu, "");
  return compact.length === 0 || /^(支持|点赞|好看|不错|哈哈|路过|打卡|来了|赞|nice|great|loveit|awesome|cool){1,3}$/i.test(compact);
}

export function classifySocialContent(input: {
  content: string;
  tenant_rules?: TenantSocialRule[];
  ai_suggestion?: { category: SocialCategory; confidence: number } | null;
}): SocialClassification {
  const content = input.content.trim();
  if (!content || content.length > 5_000 || controlCharacters.test(content)) throw new Error("invalid_social_content");
  const lower = content.toLocaleLowerCase("zh-CN");
  for (const rule of validateTenantSocialRules(input.tenant_rules ?? [])) {
    if (rule.keywords.some(keyword => lower.includes(keyword))) {
      return { category: rule.category, confidence: 0.99, source: "tenant_rule", reason_codes: ["tenant_rule_match"], matched_rule_id: rule.rule_id };
    }
  }
  if (looksLikeSpam(content)) return { category: "spam", confidence: 0.95, source: "deterministic", reason_codes: ["spam_pattern"], matched_rule_id: null };
  for (const item of patterns) {
    if (item.pattern.test(content)) return { category: item.category, confidence: item.confidence, source: "deterministic", reason_codes: [item.code], matched_rule_id: null };
  }
  if (looksGeneric(content)) return { category: "generic_interaction", confidence: 0.9, source: "deterministic", reason_codes: ["generic_interaction_pattern"], matched_rule_id: null };
  const suggestion = input.ai_suggestion;
  if (suggestion && socialCategories.includes(suggestion.category) && Number.isFinite(suggestion.confidence) && suggestion.confidence >= 0 && suggestion.confidence <= 1) {
    return { category: suggestion.category, confidence: suggestion.confidence, source: "ai", reason_codes: ["ai_classification"], matched_rule_id: null };
  }
  return { category: "unknown", confidence: 0, source: "fallback", reason_codes: ["no_supported_signal"], matched_rule_id: null };
}

export type SocialRoute = "chatwoot_dm" | "metrics_only" | "suppressed" | "chatwoot_case" | "manual_review" | "escalate";

export function decideSocialRoute(eventType: SocialEventType, classification: SocialClassification, confidenceThreshold = 0.75): {
  route: SocialRoute;
  priority: "low" | "normal" | "high" | "urgent";
  requires_human: boolean;
} {
  if (eventType === "dm.message") return { route: "chatwoot_dm", priority: "normal", requires_human: true };
  if (eventType === "auth.revoked") return { route: "escalate", priority: "urgent", requires_human: true };
  if (classification.confidence < confidenceThreshold || classification.category === "unknown") return { route: "manual_review", priority: "normal", requires_human: true };
  if (classification.category === "spam") return { route: "suppressed", priority: "low", requires_human: false };
  if (classification.category === "generic_interaction") return { route: "metrics_only", priority: "low", requires_human: false };
  if (classification.category === "complaint_risk" || classification.category === "public_crisis") {
    return { route: "escalate", priority: classification.category === "public_crisis" ? "urgent" : "high", requires_human: true };
  }
  return { route: "chatwoot_case", priority: classification.category === "after_sales" ? "high" : "normal", requires_human: true };
}

export function commentToMessageGate(input: {
  event_type: SocialEventType;
  classification: SocialClassification;
  entitlements: Iterable<string>;
  capabilities: SocialCapabilitySnapshot;
  user_authorized: boolean;
  reply_window_open: boolean;
  allowed_categories?: SocialCategory[];
  confidence_threshold?: number;
}): { allowed: boolean; reason_codes: string[]; execution_mode: "human_confirmation" } {
  const reasons: string[] = [];
  const features = new Set(input.entitlements);
  const allowed = input.allowed_categories ?? ["purchase_intent", "pre_sale_question", "after_sales"];
  const threshold = input.confidence_threshold ?? 0.8;
  if (!input.event_type.startsWith("comment.")) reasons.push("not_comment_event");
  if (!features.has("social.comment_to_message")) reasons.push("entitlement_missing");
  if (!input.capabilities.comment_to_message) reasons.push("provider_capability_missing");
  if (!input.capabilities.dm_send) reasons.push("dm_send_capability_missing");
  if (!input.user_authorized) reasons.push("user_authorization_missing");
  if (!input.reply_window_open) reasons.push("reply_window_closed");
  if (!allowed.includes(input.classification.category)) reasons.push("category_not_allowed");
  if (input.classification.confidence < threshold) reasons.push("confidence_below_threshold");
  return { allowed: reasons.length === 0, reason_codes: reasons, execution_mode: "human_confirmation" };
}

export function mockSocialCapabilities(provider: SocialProvider, now = new Date()): SocialCapabilitySnapshot {
  return {
    dm_receive: true,
    dm_send: true,
    comment_list: true,
    comment_reply: true,
    comment_hide: provider === "tiktok",
    comment_to_message: true,
    webhook: true,
    reply_window: true,
    checked_at: now.toISOString(),
    source: "mock",
  };
}
