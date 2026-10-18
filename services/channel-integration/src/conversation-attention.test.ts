import assert from "node:assert/strict";
import test from "node:test";
import { messageNotificationSummary } from "./notification-message-policy.js";

test("message body is excluded unless the tenant explicitly enables preview", () => {
  assert.equal(messageNotificationSummary(false, "订单号和隐私内容"), "微信公众号收到一条新客户消息，请进入客服工作台查看并处理。");
  assert.match(messageNotificationSummary(true, "  订单号\n测试  "), /订单号 测试/);
});
