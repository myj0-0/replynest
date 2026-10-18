import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { postPublicWebhook, publicIpv4, type PublicWebhookDependencies } from './public-webhook-transport.js';
import type { NotificationSeverity } from "./notification-core.js";
import {mediaNotice,mediaLabel,type MessageMediaNotice} from './wechat-media-core.js';

export type WebhookProvider = "feishu" | "wecom" | "dingtalk" | "custom";

const providerHosts: Record<Exclude<WebhookProvider, "custom">, string> = {
  feishu: "open.feishu.cn",
  wecom: "qyapi.weixin.qq.com",
  dingtalk: "oapi.dingtalk.com",
};

export function publicIpAddress(address: string): boolean {
  return publicIpv4(address);
}

export function validateWebhookEndpoint(provider: WebhookProvider, rawUrl: string): URL {
  if (rawUrl.length > 2048) throw new Error("Webhook URL is too long");
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("Webhook URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.hash) {
    throw new Error("Webhook URL must use public HTTPS without credentials, fragments or a custom port");
  }
  if (url.hostname.includes(':') || (isIP(url.hostname) && !publicIpAddress(url.hostname))) throw new Error("Webhook URL must target public IPv4 or a DNS hostname");
  if (provider !== "custom" && url.hostname !== providerHosts[provider]) throw new Error(`Webhook host does not match ${provider}`);
  if (provider === "feishu" && !url.pathname.startsWith("/open-apis/bot/v2/hook/")) throw new Error("Invalid Feishu robot URL");
  if (provider === "wecom" && url.pathname !== "/cgi-bin/webhook/send") throw new Error("Invalid WeCom robot URL");
  if (provider === "dingtalk" && url.pathname !== "/robot/send") throw new Error("Invalid DingTalk robot URL");
  return url;
}

export type WebhookTransportDependencies = PublicWebhookDependencies;

export function webhookPayload(provider: WebhookProvider, input: {
  event_id: string;
  severity: NotificationSeverity;
  title: string;
  summary: string;
  occurred_at: string;
  media?:MessageMediaNotice;
}) {
  const media=mediaNotice(input.media);
  const text = `ReplyNest【${input.severity === "critical" ? "紧急" : input.severity === "warning" ? "提醒" : "通知"}】${input.title}\n${input.summary}`+(media?`\n消息类型：${mediaLabel(media.message_type)} · ${media.attachment_count} 个附件，请登录客服工作台查看。${media.view_path?`\nhttps://console.replynest.cn${media.view_path}`:''}`:'');
  if (provider === "feishu") return { msg_type: "text", content: { text } };
  if (provider === "wecom" || provider === "dingtalk") return { msgtype: "text", text: { content: text } };
  // Do not spread transport input: it also carries endpoint and signing_secret.
  return { schema: "replynest.notification.v1", event_id: input.event_id, severity: input.severity,
    title: input.title, summary: input.summary, occurred_at: input.occurred_at,...(media?{media:{...media,
      ...(media.attachment_id?{attachments:[{id:media.attachment_id,content_path:`/api/v1/attachments/${media.attachment_id}/content`,authentication_required:true}]}:{})}}:{}) };
}

export async function sendNotificationWebhook(input: {
  provider: WebhookProvider;
  endpoint: string;
  signing_secret?: string;
  event_id: string;
  severity: NotificationSeverity;
  title: string;
  summary: string;
  occurred_at: string;
  media?:MessageMediaNotice;
}, dependencies: WebhookTransportDependencies = {}): Promise<void> {
  const url = validateWebhookEndpoint(input.provider, input.endpoint);
  const body = JSON.stringify(webhookPayload(input.provider, input));
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "ReplyNest-Notification-Gateway/1.0", "x-replynest-event-id": input.event_id };
  if (input.provider === "custom" && input.signing_secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers["x-replynest-timestamp"] = timestamp;
    headers["x-replynest-signature"] = `v1=${createHmac("sha256", input.signing_secret).update(timestamp).update(".").update(body).digest("hex")}`;
  }
  const responseText = await postPublicWebhook(url, body, headers, input.provider !== 'custom', dependencies);
  if (input.provider !== "custom") {
    let result: any;
    try { result = JSON.parse(responseText); } catch { throw new Error("webhook_invalid_response"); }
    const providerCode = input.provider === "feishu" ? Number(result.code ?? result.StatusCode) : Number(result.errcode);
    if (providerCode !== 0) throw new Error(`webhook_provider_${Number.isFinite(providerCode) ? providerCode : "unknown"}`);
  }
}
