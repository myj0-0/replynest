import test from "node:test";
import assert from "node:assert/strict";
import { paymentDiagnostics } from "./payment-provider.js";

test("payment adapters are disabled by default and never expose secrets", () => {
  const previous = { provider: process.env.PAYMENT_PROVIDER, live: process.env.PAYMENT_LIVE_ENABLED };
  delete process.env.PAYMENT_PROVIDER; delete process.env.PAYMENT_LIVE_ENABLED;
  const diagnostics = paymentDiagnostics();
  assert.deepEqual(diagnostics, { provider: "disabled", enabled: false, configured: true, missing: [], mode: "sandbox" });
  if (previous.provider === undefined) delete process.env.PAYMENT_PROVIDER; else process.env.PAYMENT_PROVIDER = previous.provider;
  if (previous.live === undefined) delete process.env.PAYMENT_LIVE_ENABLED; else process.env.PAYMENT_LIVE_ENABLED = previous.live;
});

test("an unknown provider fails closed instead of silently becoming disabled", () => {
  const previous = process.env.PAYMENT_PROVIDER;
  process.env.PAYMENT_PROVIDER = "typo-provider";
  const diagnostics = paymentDiagnostics();
  assert.equal(diagnostics.provider, "invalid");
  assert.equal(diagnostics.enabled, false);
  assert.equal(diagnostics.configured, false);
  assert.deepEqual(diagnostics.missing, ["PAYMENT_PROVIDER"]);
  if (previous === undefined) delete process.env.PAYMENT_PROVIDER; else process.env.PAYMENT_PROVIDER = previous;
});

test("wechat pay reports secret names but never secret values", () => {
  const names = ["PAYMENT_PROVIDER", "PAYMENT_LIVE_ENABLED", "WECHAT_PAY_MCH_ID", "WECHAT_PAY_SERIAL_NO", "WECHAT_PAY_PRIVATE_KEY", "WECHAT_PAY_PRIVATE_KEY_FILE", "WECHAT_PAY_API_V3_KEY", "WECHAT_PAY_API_V3_KEY_FILE"] as const;
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.PAYMENT_PROVIDER = "wechat_pay";
  process.env.PAYMENT_LIVE_ENABLED = "true";
  process.env.WECHAT_PAY_MCH_ID = "1900000001";
  process.env.WECHAT_PAY_API_V3_KEY = "do-not-return-this-secret";
  delete process.env.WECHAT_PAY_PRIVATE_KEY_FILE;
  delete process.env.WECHAT_PAY_API_V3_KEY_FILE;
  const diagnostics = paymentDiagnostics();
  assert.equal(diagnostics.enabled, true);
  assert.deepEqual(diagnostics.missing, ["WECHAT_PAY_SERIAL_NO", "WECHAT_PAY_PRIVATE_KEY"]);
  assert.equal(JSON.stringify(diagnostics).includes("do-not-return-this-secret"), false);
  for (const name of names) if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name];
});
