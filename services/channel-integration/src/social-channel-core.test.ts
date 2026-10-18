import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySocialContent,
  commentToMessageGate,
  decideSocialRoute,
  mockSocialCapabilities,
  normalizeSocialEvent,
  validateTenantSocialRules,
} from "./social-channel-core.js";

const now = new Date("2026-09-13T08:00:00.000Z");
const baseEvent = {
  provider: "douyin",
  channel_connection_id: "123e4567-e89b-42d3-a456-426614174000",
  external_account_id: "account-1",
  event_type: "comment.created",
  external_event_id: "event-1",
  external_user_id: "user-1",
  content: "这个商品多少钱？",
  video_id: "video-1",
  comment_id: "comment-1",
  occurred_at: "2026-09-13T07:59:00.000Z",
  metadata: { synthetic: true },
} as const;

test("normalizes a social event without retaining arbitrary nested provider payloads", () => {
  const event = normalizeSocialEvent(baseEvent, now);
  assert.equal(event.provider, "douyin");
  assert.equal(event.content_hash.length, 64);
  assert.deepEqual(event.metadata, { synthetic: true });
  assert.equal("raw_payload" in event, false);
});

test("comment events require video and comment scope", () => {
  assert.throws(() => normalizeSocialEvent({ ...baseEvent, comment_id: undefined }, now), /missing_comment_context/);
  assert.throws(() => normalizeSocialEvent({ ...baseEvent, channel_connection_id: "not-a-uuid" }, now), /invalid_channel_connection_id/);
});

test("tenant rule has priority over deterministic and AI classification", () => {
  const classification = classifySocialContent({
    content: "这个批次我要投诉并申请退款",
    tenant_rules: [{ rule_id: "batch-recall", priority: 100, category: "after_sales", keywords: ["这个批次"] }],
    ai_suggestion: { category: "purchase_intent", confidence: 0.99 },
  });
  assert.equal(classification.category, "after_sales");
  assert.equal(classification.source, "tenant_rule");
  assert.equal(classification.matched_rule_id, "batch-recall");
});

test("complaint and public crisis signals outrank generic purchase language", () => {
  assert.equal(classifySocialContent({ content: "再不退款我就向市场监管投诉" }).category, "complaint_risk");
  assert.equal(classifySocialContent({ content: "记者已经联系我准备全网曝光" }).category, "public_crisis");
});

test("classifies English review-demo comments deterministically", () => {
  assert.equal(classifySocialContent({ content: "Can I buy this in bulk? Please send me the purchase details." }).category, "purchase_intent");
  assert.equal(classifySocialContent({ content: "My order arrived damaged. How can I request a replacement?" }).category, "after_sales");
  assert.equal(classifySocialContent({ content: "I will report this if nobody handles my refund." }).category, "complaint_risk");
  assert.equal(classifySocialContent({ content: "Awesome!" }).category, "generic_interaction");
});

test("spam and ordinary interaction never become Chatwoot cases", () => {
  const spam = classifySocialContent({ content: "加微信 abcdef 加微信 ghijkl https://a.example https://b.example" });
  const generic = classifySocialContent({ content: "点赞" });
  assert.equal(decideSocialRoute("comment.created", spam).route, "suppressed");
  assert.equal(decideSocialRoute("comment.created", generic).route, "metrics_only");
});

test("high-value and after-sales comments become human Chatwoot cases", () => {
  const purchase = classifySocialContent({ content: "有货吗，我要买十件" });
  const afterSales = classifySocialContent({ content: "收到以后发现破损，怎么换货" });
  assert.deepEqual(decideSocialRoute("comment.created", purchase), { route: "chatwoot_case", priority: "normal", requires_human: true });
  assert.deepEqual(decideSocialRoute("comment.created", afterSales), { route: "chatwoot_case", priority: "high", requires_human: true });
});

test("unknown or low-confidence AI classifications require manual review", () => {
  const unknown = classifySocialContent({ content: "能详细说说吗" });
  const low = classifySocialContent({ content: "想了解", ai_suggestion: { category: "purchase_intent", confidence: 0.6 } });
  assert.equal(decideSocialRoute("comment.created", unknown).route, "manual_review");
  assert.equal(decideSocialRoute("comment.created", low).route, "manual_review");
});

test("direct messages always use the Chatwoot DM route", () => {
  const classification = classifySocialContent({ content: "你好" });
  assert.equal(decideSocialRoute("dm.message", classification).route, "chatwoot_dm");
});

test("comment-to-message requires entitlement, capabilities, authorization, window and confidence", () => {
  const classification = classifySocialContent({ content: "怎么买，我要下单" });
  const decision = commentToMessageGate({
    event_type: "comment.created",
    classification,
    entitlements: ["social.comment_to_message"],
    capabilities: mockSocialCapabilities("tiktok", now),
    user_authorized: true,
    reply_window_open: true,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.execution_mode, "human_confirmation");
});

test("comment-to-message fails closed and reports every missing gate", () => {
  const capabilities = { ...mockSocialCapabilities("douyin", now), comment_to_message: false, dm_send: false };
  const classification = classifySocialContent({ content: "点赞" });
  const decision = commentToMessageGate({
    event_type: "comment.created",
    classification,
    entitlements: [],
    capabilities,
    user_authorized: false,
    reply_window_open: false,
  });
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.reason_codes, [
    "entitlement_missing",
    "provider_capability_missing",
    "dm_send_capability_missing",
    "user_authorization_missing",
    "reply_window_closed",
    "category_not_allowed",
  ]);
});

test("tenant rules are bounded and reject duplicates", () => {
  assert.throws(() => validateTenantSocialRules([
    { rule_id: "same", priority: 1, category: "spam", keywords: ["a"] },
    { rule_id: "same", priority: 2, category: "after_sales", keywords: ["b"] },
  ]), /invalid_social_rule_id/);
});

test("tenant rules cannot deliberately classify an event as unknown", () => {
  assert.throws(() => validateTenantSocialRules([
    { rule_id: "unknown-rule", priority: 1, category: "unknown" as never, keywords: ["测试"] },
  ]), /invalid_social_rule_category/);
});
