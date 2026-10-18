import assert from "node:assert/strict";
import test from "node:test";
import { deliveryRetrySeconds, externalDeliveryAllowed, inQuietHours, meetsMinimumSeverity, safeNotificationText, validatePreference } from "./notification-core.js";

const preference = {
  channels: ["in_app", "chatwoot"] as const,
  minimum_external_severity: "warning" as const,
  quiet_hours_start: "22:00",
  quiet_hours_end: "08:00",
  timezone: "Asia/Shanghai",
  escalation_minutes: 15,
  message_notification_mode: "unattended" as const,
  unattended_minutes: 10,
  include_message_preview: false,
};

test("overnight quiet hours suppress warning but never critical", () => {
  const quiet = new Date("2026-09-01T15:00:00Z"); // 23:00 Asia/Shanghai
  const daytime = new Date("2026-09-01T04:00:00Z"); // 12:00 Asia/Shanghai
  assert.equal(inQuietHours(quiet, { ...preference, channels: [...preference.channels] }), true);
  assert.equal(inQuietHours(daytime, { ...preference, channels: [...preference.channels] }), false);
  assert.equal(externalDeliveryAllowed("warning", { ...preference, channels: [...preference.channels] }, quiet), false);
  assert.equal(externalDeliveryAllowed("critical", { ...preference, channels: [...preference.channels] }, quiet), true);
  assert.equal(externalDeliveryAllowed("info", { ...preference, channels: [...preference.channels] }, daytime), false);
  assert.equal(meetsMinimumSeverity("info", { ...preference, channels: [...preference.channels] }), false);
  assert.equal(meetsMinimumSeverity("warning", { ...preference, channels: [...preference.channels] }), true);
});

test("preference validation keeps in-app mandatory and bounds escalation", () => {
  const validated = validatePreference({ ...preference, channels: ["in_app", "enterprise_wechat"] });
  assert.deepEqual(validated.channels, ["in_app", "enterprise_wechat"]);
  assert.throws(() => validatePreference({ ...preference, channels: ["chatwoot"] }), /cannot be disabled/);
  assert.throws(() => validatePreference({ ...preference, escalation_minutes: 1 }), /between 5 and 1440/);
  assert.throws(() => validatePreference({ ...preference, unattended_minutes: 0 }), /between 1 and 1440/);
  assert.throws(() => validatePreference({ ...preference, message_notification_mode: "unknown" }), /Invalid message notification mode/);
});

test("notification text is normalized and retry delay is bounded", () => {
  assert.equal(safeNotificationText("  failure\nwithout\tsecret  ", 100), "failure without secret");
  assert.equal(deliveryRetrySeconds(1), 30);
  assert.equal(deliveryRetrySeconds(10), 900);
});
