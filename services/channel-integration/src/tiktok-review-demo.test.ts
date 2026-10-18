import assert from "node:assert/strict";
import test from "node:test";
import { createTikTokReviewMockEvent, tiktokReviewPrototypeDisclosure, validateTikTokReviewEvent } from "./tiktok-review-demo.js";

test("review demo accepts only bounded DM and comment events", () => {
  assert.deepEqual(validateTikTokReviewEvent({ event_type: "dm.message", content: " Hello " }), { event_type: "dm.message", content: "Hello" });
  assert.throws(() => validateTikTokReviewEvent({ event_type: "comment.reply", content: "hello" }), /invalid_review_demo_event_type/);
  assert.throws(() => validateTikTokReviewEvent({ event_type: "comment.created", content: "" }), /invalid_review_demo_content/);
});

test("review fixture is explicitly synthetic and never calls TikTok", () => {
  const result = createTikTokReviewMockEvent({
    channel_connection_id: "123e4567-e89b-42d3-a456-426614174000",
    external_account_id: "review-demo:tenant-1",
    event_type: "comment.created",
    content: "Can I buy this in bulk?",
  });
  assert.equal(result.event.provider, "tiktok");
  assert.deepEqual(result.event.metadata, { synthetic: true, provider_fixture: "mock-social-v1" });
  assert.equal(result.disclosure.network_calls, 0);
  assert.equal(result.disclosure.provider_writes, 0);
  assert.equal(tiktokReviewPrototypeDisclosure().live_authorization, false);
});
