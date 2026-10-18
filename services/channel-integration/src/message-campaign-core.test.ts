import test from "node:test";
import assert from "node:assert/strict";
import { campaignDeliveryRetrySeconds, campaignRecipientDecision, isCampaignQuietTime, matchesCampaignAudience, matchesCampaignCancelCondition, nextCampaignAllowedAt, normalizeCampaignInput, normalizeCampaignSchedule } from "./message-campaign-core.js";

test("campaign input is bounded and tag filters are normalized", () => {
  const value = normalizeCampaignInput({ name: " 秋季回访 ", content: "感谢关注", channel: "wechat_official_account", audience_filter: { mode: "tags_any", tags: ["会员", "会员", "新客"] } });
  assert.deepEqual(value.audience_filter.tags, ["会员", "新客"]);
  assert.throws(() => normalizeCampaignInput({ name: "x", content: "ok", channel: "wechat_official_account", audience_filter: { mode: "all" } }));
});

test("tag audience never includes a non-matching customer", () => {
  assert.equal(matchesCampaignAudience({ tags: ["会员", "上海"] }, { mode: "tags_any", tags: ["会员"] }), true);
  assert.equal(matchesCampaignAudience({ tags: ["新客"] }, { mode: "tags_any", tags: ["会员"] }), false);
});

test("marketing delivery requires explicit current consent and a ready identity", () => {
  assert.deepEqual(campaignRecipientDecision("granted", "synced"), { eligible: true, suppression_reason: null });
  assert.equal(campaignRecipientDecision("withdrawn", "synced").suppression_reason, "unsubscribed");
  assert.equal(campaignRecipientDecision(undefined, "synced").suppression_reason, "consent_missing");
  assert.equal(campaignRecipientDecision("granted", "pending").suppression_reason, "identity_not_ready");
});

test("schedule validates timezone, rate and cancellation condition", () => {
  const now = new Date("2026-09-10T02:00:00Z");
  const value = normalizeCampaignSchedule({ scheduled_at: now.toISOString(), timezone: "Asia/Shanghai", quiet_hours_start: "22:00", quiet_hours_end: "08:00", rate_limit_per_minute: 20, cancel_condition: { type: "customer_attribute_equals", key: "purchased", value: "true" } }, now);
  assert.equal(value.rate_limit_per_minute, 20);
  assert.equal(matchesCampaignCancelCondition({ purchased: true }, value.cancel_condition), true);
  assert.throws(() => normalizeCampaignSchedule({ scheduled_at: now.toISOString(), timezone: "Invalid/Zone" }, now));
});

test("overnight quiet hours defer until the local end boundary", () => {
  const quiet = new Date("2026-09-10T15:30:00Z"); // 23:30 Asia/Shanghai
  assert.equal(isCampaignQuietTime(quiet, "Asia/Shanghai", "22:00", "08:00"), true);
  assert.equal(nextCampaignAllowedAt(quiet, "Asia/Shanghai", "22:00", "08:00").toISOString(), "2026-09-11T00:00:00.000Z");
  assert.equal(isCampaignQuietTime(new Date("2026-09-10T04:00:00Z"), "Asia/Shanghai", "22:00", "08:00"), false);
});

test("campaign delivery retries are bounded", () => {
  assert.equal(campaignDeliveryRetrySeconds(1), 5);
  assert.equal(campaignDeliveryRetrySeconds(4), 40);
  assert.equal(campaignDeliveryRetrySeconds(20), 300);
});
