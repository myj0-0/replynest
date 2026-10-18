import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readWeChatCredential, validateCallbackKey } from "./wechat-connection.js";

test("connection credential stays inside the allowlisted root and validates WeChat formats", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "replynest-wechat-"));
  const previous = process.env.WECHAT_CHANNEL_SECRET_ROOT;
  process.env.WECHAT_CHANNEL_SECRET_ROOT = root;
  const file = path.join(root, "account.json");
  await writeFile(file, JSON.stringify({
    app_id: "wx1234567890abcdef",
    app_secret: "a".repeat(32),
    token: "ReplyNestCallback",
    encoding_aes_key: "A".repeat(43),
  }));
  try {
    const credential = await readWeChatCredential(file, "wx1234567890abcdef");
    assert.equal(credential.token, "ReplyNestCallback");
    await assert.rejects(readWeChatCredential(path.join(root, "..", "outside.json"), "wx1234567890abcdef"), /outside_root/);
  } finally {
    if (previous === undefined) delete process.env.WECHAT_CHANNEL_SECRET_ROOT; else process.env.WECHAT_CHANNEL_SECRET_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("callback keys are URL-safe and non-trivial", () => {
  assert.equal(validateCallbackKey("rnwc_1234567890abcdef"), "rnwc_1234567890abcdef");
  assert.throws(() => validateCallbackKey("short"), /invalid_wechat_callback_key/);
  assert.throws(() => validateCallbackKey("unsafe/value/12345"), /invalid_wechat_callback_key/);
});
