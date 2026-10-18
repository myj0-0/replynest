import webpush, { type PushSubscription } from "web-push";
import { pool } from "./database.js";
import { decryptWebhookSecret, encryptWebhookSecret } from "./notification-webhook-crypto.js";
import { safeNotificationText, type NotificationSeverity } from "./notification-core.js";
import { secretValue } from "./secret-value.js";
import { browserPushConfig, validateBrowserSubscription } from "./browser-push-core.js";

export type BrowserPushEvent = { title: string; summary: string; severity: NotificationSeverity; notification_id: string };

export async function saveBrowserSubscription(tenantId: string, platformUserId: string, input: Record<string, unknown>, userAgent?: string) {
  const value = validateBrowserSubscription(input);
  const saved = await pool.query(
    `INSERT INTO browser_push_subscriptions
      (tenant_id,platform_user_id,endpoint_hash,endpoint_ciphertext,p256dh_ciphertext,auth_ciphertext,device_label,user_agent,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')
     ON CONFLICT (tenant_id,platform_user_id,endpoint_hash) DO UPDATE SET
       endpoint_ciphertext=EXCLUDED.endpoint_ciphertext,p256dh_ciphertext=EXCLUDED.p256dh_ciphertext,
       auth_ciphertext=EXCLUDED.auth_ciphertext,device_label=EXCLUDED.device_label,user_agent=EXCLUDED.user_agent,
       status='active',failure_count=0,updated_at=NOW()
     RETURNING subscription_id,device_label,status,created_at,updated_at`,
    [tenantId, platformUserId, value.endpoint_hash, encryptWebhookSecret(value.endpoint), encryptWebhookSecret(value.p256dh),
     encryptWebhookSecret(value.auth), value.device_label, userAgent?.slice(0, 300) || null],
  );
  return saved.rows[0];
}

export async function sendBrowserPush(subscriptionId: string, tenantId: string, event: BrowserPushEvent): Promise<"delivered" | "expired"> {
  const config = browserPushConfig();
  if (!config.enabled) throw new Error("browser_push_not_configured");
  const row = await pool.query<{ endpoint_ciphertext: string; p256dh_ciphertext: string; auth_ciphertext: string }>(
    `SELECT endpoint_ciphertext,p256dh_ciphertext,auth_ciphertext FROM browser_push_subscriptions
      WHERE subscription_id=$1 AND tenant_id=$2 AND status='active'`, [subscriptionId, tenantId],
  );
  if (!row.rows[0]) return "expired";
  const privateKey = secretValue("WEB_PUSH_VAPID_PRIVATE_KEY")!;
  webpush.setVapidDetails(process.env.WEB_PUSH_VAPID_SUBJECT!, config.public_key, privateKey);
  const subscription: PushSubscription = {
    endpoint: decryptWebhookSecret(row.rows[0].endpoint_ciphertext),
    keys: { p256dh: decryptWebhookSecret(row.rows[0].p256dh_ciphertext), auth: decryptWebhookSecret(row.rows[0].auth_ciphertext) },
  };
  try {
    await webpush.sendNotification(subscription, JSON.stringify({
      title: safeNotificationText(event.title, 160), body: safeNotificationText(event.summary, 300),
      tag: event.notification_id, data: { url: "/notifications", notification_id: event.notification_id },
      badge: "/replynest-icon.svg", icon: "/replynest-icon.svg", severity: event.severity,
    }), { TTL: event.severity === "critical" ? 3600 : 900, urgency: event.severity === "critical" ? "high" : "normal" });
    await pool.query(`UPDATE browser_push_subscriptions SET failure_count=0,last_success_at=NOW(),updated_at=NOW() WHERE subscription_id=$1`, [subscriptionId]);
    return "delivered";
  } catch (error: any) {
    if (error?.statusCode === 404 || error?.statusCode === 410) {
      await pool.query(`UPDATE browser_push_subscriptions SET status='expired',last_failure_at=NOW(),updated_at=NOW() WHERE subscription_id=$1`, [subscriptionId]);
      return "expired";
    }
    await pool.query(`UPDATE browser_push_subscriptions SET failure_count=failure_count+1,last_failure_at=NOW(),updated_at=NOW() WHERE subscription_id=$1`, [subscriptionId]);
    throw error;
  }
}
