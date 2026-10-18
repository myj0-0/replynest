import { requiredEnv } from "./shared.js";
import type { WebhookProvider } from "./notification-webhook-adapter.js";

const baseUrl = `http://127.0.0.1:${process.env.PORT ?? 3001}`;
const apiKey = requiredEnv("DEMO_TENANT_API_KEY");
const input = await new Promise<string>((resolve, reject) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    value += chunk;
    if (value.length > 16_384) reject(new Error("Webhook configuration input is too large"));
  });
  process.stdin.on("end", () => resolve(value));
  process.stdin.on("error", reject);
});
let configurations: Array<{ provider: WebhookProvider; display_name: string; endpoint: string }>;
try {
  configurations = JSON.parse(input) as Array<{ provider: WebhookProvider; display_name: string; endpoint: string }>;
} catch {
  throw new Error("Webhook configuration input is not valid JSON");
}
if (!Array.isArray(configurations) || configurations.length > 10) throw new Error("Webhook configuration must be a bounded array");
const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
const listed = await fetch(`${baseUrl}/api/v1/notification-destinations`, { headers });
if (!listed.ok) throw new Error(`Could not list notification destinations: ${listed.status}`);
const existing = (await listed.json() as any).data ?? [];

for (const configuration of configurations) {
  const match = existing.find((item: any) => item.display_name === configuration.display_name);
  const response = await fetch(`${baseUrl}/api/v1/notification-destinations${match ? `/${match.destination_id}` : ""}`, {
    method: match ? "PUT" : "POST",
    headers,
    body: JSON.stringify({ ...configuration, status: "active" }),
  });
  if (!response.ok) throw new Error(`Webhook ${configuration.provider} configuration failed: ${response.status}`);
  console.log(`webhook_provider=${configuration.provider} configuration=${match ? "updated" : "created"}`);
}

const preference = await fetch(`${baseUrl}/api/v1/notification-preferences`, {
  method: "PUT",
  headers,
  body: JSON.stringify({
    channels: ["in_app", "chatwoot"],
    minimum_external_severity: "warning",
    quiet_hours_start: "22:00",
    quiet_hours_end: "08:00",
    timezone: "Asia/Shanghai",
    escalation_minutes: 15,
    message_notification_mode: "unattended",
    unattended_minutes: 10,
    include_message_preview: false,
  }),
});
if (!preference.ok) throw new Error(`Notification preference configuration failed: ${preference.status}`);
console.log("notification_message_policy=unattended unattended_minutes=10 message_preview=false");
