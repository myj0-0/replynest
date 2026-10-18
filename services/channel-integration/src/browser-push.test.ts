import assert from "node:assert/strict";
import test from "node:test";
import { browserPushConfig, validateBrowserSubscription } from "./browser-push-core.js";

test("browser push subscription accepts an HTTPS capability URL and browser keys", () => {
  const value = validateBrowserSubscription({
    endpoint: "https://fcm.googleapis.com/fcm/send/example",
    keys: { p256dh: "A".repeat(65), auth: "B".repeat(22) },
    device_label: " 当前浏览器 ",
  });
  assert.equal(value.device_label, "当前浏览器");
  assert.equal(value.endpoint_hash.length, 64);
});

test("browser push subscription rejects non-HTTPS endpoints and malformed keys", () => {
  assert.throws(() => validateBrowserSubscription({ endpoint: "http://127.0.0.1/push", keys: { p256dh: "A".repeat(65), auth: "B".repeat(22) } }));
  assert.throws(() => validateBrowserSubscription({ endpoint: "https://example.com/push", keys: { p256dh: "A".repeat(65), auth: "B".repeat(22) } }));
  assert.throws(() => validateBrowserSubscription({ endpoint: "https://fcm.googleapis.com/push", keys: { p256dh: "bad+key", auth: "short" } }));
});

test("browser push is disabled unless the complete VAPID configuration exists", () => {
  const previous = [process.env.WEB_PUSH_VAPID_PUBLIC_KEY, process.env.WEB_PUSH_VAPID_PRIVATE_KEY, process.env.WEB_PUSH_VAPID_SUBJECT];
  delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY; delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY; delete process.env.WEB_PUSH_VAPID_SUBJECT;
  try { assert.equal(browserPushConfig().enabled, false); }
  finally {
    const names = ["WEB_PUSH_VAPID_PUBLIC_KEY", "WEB_PUSH_VAPID_PRIVATE_KEY", "WEB_PUSH_VAPID_SUBJECT"] as const;
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
});
