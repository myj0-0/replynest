import { safeNotificationText } from "./notification-core.js";

export function messageNotificationSummary(includePreview: boolean, text?: string): string {
  if (!includePreview || !text) return "微信公众号收到一条新客户消息，请进入客服工作台查看并处理。";
  return `微信公众号收到一条新客户消息：${safeNotificationText(text, 120)}`;
}
