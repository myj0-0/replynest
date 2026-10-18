import assert from "node:assert/strict";
import test from "node:test";
import { mailProviderDiagnostic, mailProviderDiagnostics } from "./mail-provider.js";
import { classifySmsProviderFailure, normalizeMainlandPhone, smsProviderDiagnostic } from "./sms-provider.js";

test("mail provider can switch without exposing credentials", () => {
  const before = process.env.MAIL_PROVIDER;
  process.env.MAIL_PROVIDER = "mailgun";
  process.env.MAILGUN_API_KEY = "test-secret-that-must-not-be-returned";
  process.env.MAILGUN_DOMAIN = "mg.example.test";
  process.env.MAILGUN_FROM = "no-reply@example.test";
  const result = mailProviderDiagnostic();
  assert.equal(result.configured, true);
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
  if (before === undefined) delete process.env.MAIL_PROVIDER; else process.env.MAIL_PROVIDER = before;
  delete process.env.MAILGUN_API_KEY;
  delete process.env.MAILGUN_DOMAIN;
  delete process.env.MAILGUN_FROM;
});

test("mail diagnostics report every switchable provider while preserving the selected provider", () => {
  const before = process.env.MAIL_PROVIDER;
  process.env.MAIL_PROVIDER = "mailpit";
  process.env.SMTP_HOST = "mailpit";
  process.env.SMTP_FROM = "no-reply@example.test";
  process.env.ALIYUN_MAIL_SMTP_HOST = "smtp.example.test";
  process.env.ALIYUN_MAIL_SMTP_USERNAME = "aliyun-user-secret@example.test";
  process.env.ALIYUN_MAIL_SMTP_PASSWORD = "aliyun-password-secret";
  process.env.ALIYUN_MAIL_FROM = "sender@example.test";
  process.env.MAILGUN_API_KEY = "mailgun-key-secret";
  process.env.MAILGUN_DOMAIN = "mg.example.test";
  process.env.MAILGUN_FROM = "sender@mg.example.test";
  const diagnostics = mailProviderDiagnostics();
  assert.equal(diagnostics.selected, "mailpit");
  assert.deepEqual(diagnostics.providers.map(item => item.provider), ["mailpit", "aliyun_smtp", "mailgun"]);
  assert.equal(diagnostics.providers.every(item => item.configured), true);
  assert.equal(JSON.stringify(diagnostics).includes("aliyun-password-secret"), false);
  assert.equal(JSON.stringify(diagnostics).includes("mailgun-key-secret"), false);
  if (before === undefined) delete process.env.MAIL_PROVIDER; else process.env.MAIL_PROVIDER = before;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
  delete process.env.ALIYUN_MAIL_SMTP_HOST;
  delete process.env.ALIYUN_MAIL_SMTP_USERNAME;
  delete process.env.ALIYUN_MAIL_SMTP_PASSWORD;
  delete process.env.ALIYUN_MAIL_FROM;
  delete process.env.MAILGUN_API_KEY;
  delete process.env.MAILGUN_DOMAIN;
  delete process.env.MAILGUN_FROM;
});

test("mainland phone normalization accepts common prefixes and rejects invalid numbers", () => {
  assert.equal(normalizeMainlandPhone("+86 138-0013-8000"), "13800138000");
  assert.equal(normalizeMainlandPhone("008613800138000"), "13800138000");
  assert.equal(normalizeMainlandPhone("12800138000"), undefined);
});

test("SMS defaults to a non-live mock provider", () => {
  const before = process.env.SMS_PROVIDER;
  delete process.env.SMS_PROVIDER;
  assert.deepEqual(smsProviderDiagnostic(), { provider: "mock", configured: true, live_send_enabled: false, missing: [], endpoint: "local://mock-sms" });
  if (before !== undefined) process.env.SMS_PROVIDER = before;
});

test("SMS provider failures are classified without retaining unsafe messages", () => {
  assert.deepEqual(classifySmsProviderFailure("isv.BUSINESS_LIMIT_CONTROL"), { provider_code: "isv.BUSINESS_LIMIT_CONTROL", category: "rate_limit", retryable: true });
  assert.equal(classifySmsProviderFailure("isv.SMS_SIGNATURE_ILLEGAL").category, "template_or_signature");
  assert.equal(classifySmsProviderFailure("InvalidAccessKeyId.NotFound").category, "authentication");
  assert.deepEqual(classifySmsProviderFailure("unsafe provider message with spaces and phone 13800138000"), { provider_code: "unknown", category: "unknown", retryable: false });
});
