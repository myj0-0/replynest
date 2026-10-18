import assert from "node:assert/strict";
import test from "node:test";
import { decryptWebhookSecret, encryptWebhookSecret } from "./notification-webhook-crypto.js";

test("webhook URLs are encrypted with authenticated encryption", () => {
  const previous = process.env.NOTIFICATION_WEBHOOK_MASTER_KEY;
  process.env.NOTIFICATION_WEBHOOK_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    const encrypted = encryptWebhookSecret("https://example.com/hooks/private-token");
    assert.match(encrypted, /^v1\./);
    assert.ok(!encrypted.includes("private-token"));
    assert.equal(decryptWebhookSecret(encrypted), "https://example.com/hooks/private-token");
    const parts = encrypted.split(".");
    parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    assert.throws(() => decryptWebhookSecret(parts.join(".")));
  } finally {
    if (previous === undefined) delete process.env.NOTIFICATION_WEBHOOK_MASTER_KEY;
    else process.env.NOTIFICATION_WEBHOOK_MASTER_KEY = previous;
  }
});
