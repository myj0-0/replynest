import test from "node:test";
import assert from "node:assert/strict";
import { parseFaultInjection, shouldSendFailureAlert } from "./fault-injection.mjs";

const now = Date.parse("2026-08-29T10:00:00Z");
const targets = new Set(["console", "wechat_callback"]);

test("accepts a bounded allowlisted drill", () => {
  const value = parseFaultInjection(JSON.stringify({
    schema_version: 1,
    target_id: "wechat_callback",
    drill_id: "drill-20260829",
    expires_at: "2026-08-29T10:05:00Z"
  }), targets, now);
  assert.equal(value?.target_id, "wechat_callback");
});

test("rejects invalid, expired, excessive, or unknown drills", () => {
  assert.equal(parseFaultInjection("not-json", targets, now), null);
  assert.equal(parseFaultInjection(JSON.stringify({ schema_version: 1, target_id: "other", drill_id: "x", expires_at: "2026-08-29T10:05:00Z" }), targets, now), null);
  assert.equal(parseFaultInjection(JSON.stringify({ schema_version: 1, target_id: "console", drill_id: "x", expires_at: "2026-08-29T09:59:00Z" }), targets, now), null);
  assert.equal(parseFaultInjection(JSON.stringify({ schema_version: 1, target_id: "console", drill_id: "x", expires_at: "2026-08-29T10:16:00Z" }), targets, now), null);
  assert.equal(parseFaultInjection(JSON.stringify({ schema_version: 1, target_id: "console", drill_id: "bad id", expires_at: "2026-08-29T10:05:00Z" }), targets, now), null);
});

test("suppresses repeated alerts until cooldown elapses", () => {
  assert.equal(shouldSendFailureAlert("up", now - 1_000, now, 30 * 60_000), true);
  assert.equal(shouldSendFailureAlert("down", now - 60_000, now, 30 * 60_000), false);
  assert.equal(shouldSendFailureAlert("down", now - 30 * 60_000, now, 30 * 60_000), true);
});
