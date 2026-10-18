import assert from "node:assert/strict";
import test from "node:test";
import { MockSocialProvider } from "./mock-social-provider.js";
import { normalizeSocialEvent } from "./social-channel-core.js";

test("mock social provider produces normalized comments without network calls", () => {
  const provider = new MockSocialProvider();
  const event = provider.event({
    provider: "tiktok",
    channel_connection_id: "123e4567-e89b-42d3-a456-426614174000",
    external_account_id: "business-1",
    event_type: "comment.created",
    content: "怎么买？",
  });
  const normalized = normalizeSocialEvent(event);
  assert.equal(normalized.provider, "tiktok");
  assert.equal(normalized.metadata.synthetic, true);
  assert.ok(normalized.video_id);
  assert.ok(normalized.comment_id);
  assert.equal(provider.networkCalls, 0);
});

test("mock capabilities are explicitly synthetic", () => {
  const provider = new MockSocialProvider();
  const capabilities = provider.capabilities("douyin", new Date("2026-09-13T08:00:00Z"));
  assert.equal(capabilities.source, "mock");
  assert.equal(capabilities.dm_receive, true);
});
