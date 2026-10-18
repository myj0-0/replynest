import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMonitorConfig, publicMonitorConfig, validateDestination } from "./runtime-config.mjs";

test("normalizes safe probe bounds and keeps legacy Feishu destination", () => {
  const config = normalizeMonitorConfig({ probe: { request_timeout_seconds: 45, failure_threshold: 6, repeat_alert_seconds: 900 } }, {
    FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/example"
  });
  assert.equal(config.probe.request_timeout_seconds, 45);
  assert.equal(config.probe.failure_threshold, 6);
  assert.equal(config.destinations[0].provider, "feishu");
});

test("rejects provider host confusion and private custom targets", () => {
  assert.throws(() => validateDestination({ provider: "feishu", display_name: "x", endpoint: "https://example.com/hook" }));
  assert.throws(() => validateDestination({ provider: "custom", display_name: "x", endpoint: "https://127.0.0.1/hook" }));
});

test("never returns endpoint secrets to the admin UI", () => {
  const config = normalizeMonitorConfig({ destinations: [{ destination_id: "one", provider: "custom", display_name: "Ops", endpoint: "https://hooks.example.com/a", signing_secret: "1234567890abcdef" }] }, {});
  const output = publicMonitorConfig(config);
  assert.equal(output.destinations[0].endpoint_host, "hooks.example.com");
  assert.equal("endpoint" in output.destinations[0], false);
  assert.equal(output.destinations[0].signing_configured, true);
});
