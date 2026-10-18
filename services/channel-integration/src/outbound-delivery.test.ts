import assert from "node:assert/strict";
import test from "node:test";
import { classifyOutboundFailure, failureNote, retryDelaySeconds } from "./outbound-delivery.js";

test("48001 is a permanent permission failure", () => {
  assert.deepEqual(classifyOutboundFailure(new Error("wechat_send_error:48001:api unauthorized")), {
    code: "api_unauthorized",
    message: "当前公众号没有客服消息接口权限",
    retryable: false,
    retryAfterSeconds: null
  });
});

test("token expiry and network errors are retryable", () => {
  assert.equal(classifyOutboundFailure(new Error("wechat_send_error:42001:access_token expired")).retryable, true);
  assert.equal(classifyOutboundFailure(new Error("fetch failed: ECONNRESET")).code, "transient_network_error");
});

test("unknown provider errors stop instead of retrying blindly", () => {
  const result = classifyOutboundFailure(new Error("wechat_send_error:49999:unknown"));
  assert.equal(result.retryable, false);
  assert.equal(result.code, "wechat_49999");
});

test("retry delay applies bounded exponential backoff", () => {
  assert.equal(retryDelaySeconds(30, 1), 30);
  assert.equal(retryDelaySeconds(30, 3), 120);
  assert.equal(retryDelaySeconds(60, 8), 900);
});

test("failure note does not expose recipient identifiers", () => {
  const failure = classifyOutboundFailure(new Error("wechat_send_error:48001:api unauthorized"));
  const note = failureNote("42", failure, false);
  assert.match(note, /api_unauthorized/);
  assert.match(note, /停止自动重试/);
});
