import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { secretValue } from "./secret-value.js";

function masterKey(): Buffer {
  const configured = secretValue("NOTIFICATION_WEBHOOK_MASTER_KEY");
  if (configured) {
    const key = /^[a-f0-9]{64}$/i.test(configured) ? Buffer.from(configured, "hex") : Buffer.from(configured, "base64");
    if (key.length !== 32) throw new Error("Notification webhook master key must contain exactly 32 bytes");
    return key;
  }
  if (process.env.CONSOLE_DEMO_LOGIN === "true") {
    const developmentSeed = secretValue("MOCK_WECHAT_SECRET");
    if (developmentSeed) return createHash("sha256").update("replynest:webhook:v1:").update(developmentSeed).digest();
  }
  throw new Error("Notification webhook master key is not configured");
}

export function encryptWebhookSecret(value: string): string {
  if (!value || value.length > 4096 || value.includes("\0")) throw new Error("Webhook secret value is invalid");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  cipher.setAAD(Buffer.from("replynest:notification-webhook:v1"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

export function decryptWebhookSecret(value: string): string {
  const [version, ivText, ciphertextText, tagText, extra] = value.split(".");
  if (version !== "v1" || !ivText || !ciphertextText || !tagText || extra) throw new Error("Webhook ciphertext format is invalid");
  const iv = Buffer.from(ivText, "base64url");
  const ciphertext = Buffer.from(ciphertextText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 4096) throw new Error("Webhook ciphertext is invalid");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAAD(Buffer.from("replynest:notification-webhook:v1"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
