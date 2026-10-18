import { readFileSync } from "node:fs";
import { sendNotificationWebhook, type WebhookProvider } from "./notification-webhook-adapter.js";

const pwFile = process.env.PW_FILE;
if (!pwFile) throw new Error("PW_FILE is required");
const content = readFileSync(pwFile, "utf8");
const section = content.slice(content.indexOf("## 用于通知接收 WebHook"));
if (!section) throw new Error("Notification Webhook section was not found");
const configurations: Array<{ provider: WebhookProvider; label: string; pattern: RegExp }> = [
  { provider: "feishu", label: "飞书", pattern: /飞书WebHook[：:]\s*(https:\/\/\S+)/i },
  { provider: "wecom", label: "企业微信", pattern: /企业微信WebHook[：:]\s*(https:\/\/\S+)/i },
  { provider: "dingtalk", label: "钉钉", pattern: /钉钉WebHook[：:]\s*(https:\/\/\S+)/i },
];

for (const configuration of configurations) {
  const endpoint = configuration.pattern.exec(section)?.[1]?.replace(/[`\s]+$/, "");
  if (!endpoint) throw new Error(`${configuration.label} Webhook is missing`);
  await sendNotificationWebhook({
    provider: configuration.provider,
    endpoint,
    event_id: `phase5.2-smoke-${configuration.provider}-${Date.now()}`,
    severity: "info",
    title: "Phase 5.2 Webhook 连通性测试",
    summary: "ReplyNest 测试通知：本消息不包含客户数据，无需处理。",
    occurred_at: new Date().toISOString(),
  });
  console.log(`webhook_provider=${configuration.provider} result=delivered`);
}
