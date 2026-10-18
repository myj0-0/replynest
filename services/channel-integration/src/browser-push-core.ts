import { createHash } from "node:crypto";
import { safeNotificationText } from "./notification-core.js";
import { secretValue } from "./secret-value.js";

export function browserPushConfig() {
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = secretValue("WEB_PUSH_VAPID_PRIVATE_KEY");
  const subject = process.env.WEB_PUSH_VAPID_SUBJECT?.trim() ?? "";
  const validPublic = /^[A-Za-z0-9_-]{80,100}$/.test(publicKey);
  const validPrivate = Boolean(privateKey && /^[A-Za-z0-9_-]{40,60}$/.test(privateKey));
  return { enabled: Boolean(validPublic && validPrivate && /^(mailto:|https:\/\/)/.test(subject)), public_key: publicKey };
}

function endpointHash(endpoint: string) { return createHash("sha256").update(endpoint).digest("hex"); }
function base64Url(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string" || !new RegExp(`^[A-Za-z0-9_-]{${minimum},${maximum}}$`).test(value)) throw new Error("invalid_push_key");
  return value;
}

export function validateBrowserSubscription(input: Record<string, unknown>) {
  const endpoint = String(input.endpoint ?? "");
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new Error("invalid_push_endpoint"); }
  if (parsed.protocol !== "https:" || endpoint.length > 2048 || parsed.username || parsed.password) throw new Error("invalid_push_endpoint");
  const host = parsed.hostname.toLowerCase();
  const supportedHost = host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com" ||
    host === "push.services.mozilla.com" || host === "web.push.apple.com" || host.endsWith(".push.apple.com") ||
    host.endsWith(".notify.windows.com");
  if (!supportedHost) throw new Error("unsupported_push_service");
  const keys = input.keys && typeof input.keys === "object" && !Array.isArray(input.keys) ? input.keys as Record<string, unknown> : {};
  return { endpoint, endpoint_hash: endpointHash(endpoint), p256dh: base64Url(keys.p256dh, 40, 256), auth: base64Url(keys.auth, 8, 128), device_label: safeNotificationText(input.device_label ?? "Browser", 80) };
}
