import assert from "node:assert/strict";
import test from "node:test";
import { verifyCaptchaToken } from "./captcha.js";

test("captcha is bypassed only when explicitly disabled", async () => {
  const previous = process.env.CAPTCHA_ENABLED;
  process.env.CAPTCHA_ENABLED = "false";
  assert.equal(await verifyCaptchaToken(undefined), true);
  if (previous === undefined) delete process.env.CAPTCHA_ENABLED; else process.env.CAPTCHA_ENABLED = previous;
});

test("captcha rejects missing tokens when enabled", async () => {
  const previous = process.env.CAPTCHA_ENABLED;
  process.env.CAPTCHA_ENABLED = "true";
  assert.equal(await verifyCaptchaToken(undefined), false);
  if (previous === undefined) delete process.env.CAPTCHA_ENABLED; else process.env.CAPTCHA_ENABLED = previous;
});

test("captcha forwards Cap three-part tokens to siteverify as JSON", async () => {
  const previous = {
    enabled: process.env.CAPTCHA_ENABLED,
    url: process.env.CAPTCHA_INTERNAL_URL,
    key: process.env.CAPTCHA_SITE_KEY,
    secret: process.env.CAPTCHA_SITE_SECRET,
    secretFile: process.env.CAPTCHA_SITE_SECRET_FILE
  };
  process.env.CAPTCHA_ENABLED = "true";
  process.env.CAPTCHA_INTERNAL_URL = "http://cap:3000";
  process.env.CAPTCHA_SITE_KEY = "sitekey12";
  process.env.CAPTCHA_SITE_SECRET = "test-secret";
  delete process.env.CAPTCHA_SITE_SECRET_FILE;
  try {
    const accepted = await verifyCaptchaToken("sitekey12:redeemed-token:signature", async (input, init) => {
      assert.equal(String(input), "http://cap:3000/sitekey12/siteverify");
      assert.equal(init?.headers && (init.headers as Record<string, string>)["content-type"], "application/json");
      assert.deepEqual(JSON.parse(String(init?.body)), { secret: "test-secret", response: "sitekey12:redeemed-token:signature" });
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    assert.equal(accepted, true);
    assert.equal(await verifyCaptchaToken("otherkey:redeemed-token:signature", async () => {
      throw new Error("siteverify must not be called for a different site key");
    }), false);
  } finally {
    if (previous.enabled === undefined) delete process.env.CAPTCHA_ENABLED; else process.env.CAPTCHA_ENABLED = previous.enabled;
    if (previous.url === undefined) delete process.env.CAPTCHA_INTERNAL_URL; else process.env.CAPTCHA_INTERNAL_URL = previous.url;
    if (previous.key === undefined) delete process.env.CAPTCHA_SITE_KEY; else process.env.CAPTCHA_SITE_KEY = previous.key;
    if (previous.secret === undefined) delete process.env.CAPTCHA_SITE_SECRET; else process.env.CAPTCHA_SITE_SECRET = previous.secret;
    if (previous.secretFile === undefined) delete process.env.CAPTCHA_SITE_SECRET_FILE; else process.env.CAPTCHA_SITE_SECRET_FILE = previous.secretFile;
  }
});
