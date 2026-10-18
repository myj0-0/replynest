import { emitNotification, type EmitNotificationInput } from "./notification-gateway.js";
import type { SocialCategory, SocialEventType } from "./social-channel-core.js";
import { correctedSocialRoute } from "./social-moderation-core.js";

export async function emitSocialModerationNotification(input: {
  tenant_id: string;
  social_event_id: string;
  event_type: SocialEventType;
  category: SocialCategory;
  actor_type?: string;
  actor_id?: string;
  request_id?: string;
  delivery_mode?: EmitNotificationInput["delivery_mode"];
}) {
  if (input.event_type === "dm.message" || input.event_type === "auth.revoked") return null;
  const route = input.category === "unknown"
    ? { route: "manual_review" as const, priority: "normal" as const, requires_human: true }
    : correctedSocialRoute(input.event_type, input.category);
  if (!route.requires_human || route.route === "suppressed" || route.route === "metrics_only") return null;
  const risk = input.category === "complaint_risk" || input.category === "public_crisis";
  const review = route.route === "manual_review";
  return emitNotification({
    tenant_id: input.tenant_id,
    event_type: risk ? "social.comment_risk" : review ? "social.comment_review" : "social.comment_action",
    severity: input.category === "public_crisis" ? "critical" : risk || review ? "warning" : "info",
    title: input.category === "public_crisis" ? "社交平台评论存在舆情风险" : risk ? "社交平台评论存在投诉风险" : review ? "社交评论需要人工复核" : "社交评论需要人工处理",
    summary: "系统已生成社交评论人工待办。请在渠道与接入页面核对分类并记录处理结果。",
    dedupe_key: `social.${input.social_event_id}`,
    resource_type: "social_event",
    resource_id: input.social_event_id,
    metadata: { source: "social_moderation" },
    actor_type: input.actor_type ?? "channel_gateway",
    actor_id: input.actor_id ?? "social_router",
    request_id: input.request_id,
    requires_action: true,
    webhook_scope: "system",
    delivery_mode: input.delivery_mode,
  });
}
