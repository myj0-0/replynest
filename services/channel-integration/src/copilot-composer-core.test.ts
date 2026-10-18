import assert from "node:assert/strict";
import test from "node:test";
import { classifyDeliveredRecommendation, normalizeReplyText } from "./copilot-composer-core.js";

test("composer delivery treats line ending and trailing whitespace changes as unchanged", () => {
  assert.equal(normalizeReplyText("您好  \r\n可以退款。\n"), "您好\n可以退款。");
  assert.equal(classifyDeliveredRecommendation("您好\n可以退款。", "您好  \r\n可以退款。\n"), "accepted");
});

test("composer delivery marks substantive agent changes as edited", () => {
  assert.equal(classifyDeliveredRecommendation("可以退款。", "请先核对订单，符合条件后可以退款。"), "edited");
});
