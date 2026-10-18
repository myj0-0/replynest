export type NotificationSeverity = "info" | "warning" | "critical";
export type NotificationChannel = "in_app" | "chatwoot" | "enterprise_wechat" | "browser_push" | "webhook";
export type MessageNotificationMode = "off" | "every_message" | "unattended" | "both";

export type NotificationPreference = {
  channels: NotificationChannel[];
  minimum_external_severity: NotificationSeverity;
  quiet_hours_start: string;
  quiet_hours_end: string;
  timezone: string;
  escalation_minutes: number;
  message_notification_mode: MessageNotificationMode;
  unattended_minutes: number;
  include_message_preview: boolean;
};

const severityRank: Record<NotificationSeverity, number> = { info: 0, warning: 1, critical: 2 };

export function safeNotificationText(value: unknown, maximum: number): string {
  if (typeof value !== "string") throw new Error("Notification text must be a string");
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("Notification text must not be empty");
  return normalized.slice(0, maximum);
}

export function validDedupeKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:_.-]{2,159}$/.test(value);
}

export function parseClock(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Quiet hour must use HH:mm");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("Quiet hour is outside the clock range");
  return hour * 60 + minute;
}

function localMinute(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find(part => part.type === "hour")?.value);
  const minute = Number(parts.find(part => part.type === "minute")?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) throw new Error("Unable to resolve tenant local time");
  return hour * 60 + minute;
}

export function inQuietHours(date: Date, preference: NotificationPreference): boolean {
  const start = parseClock(preference.quiet_hours_start);
  const end = parseClock(preference.quiet_hours_end);
  if (start === end) return false;
  const current = localMinute(date, preference.timezone);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function meetsMinimumSeverity(severity: NotificationSeverity, preference: NotificationPreference): boolean {
  return severityRank[severity] >= severityRank[preference.minimum_external_severity];
}

export function externalDeliveryAllowed(severity: NotificationSeverity, preference: NotificationPreference, now = new Date()): boolean {
  if (!meetsMinimumSeverity(severity, preference)) return false;
  return severity === "critical" || !inQuietHours(now, preference);
}

export function deliveryRetrySeconds(attempt: number): number {
  return Math.min(900, 30 * 2 ** Math.max(0, attempt - 1));
}

export function validatePreference(input: Record<string, unknown>): NotificationPreference {
  const allowedChannels: NotificationChannel[] = ["in_app", "chatwoot", "enterprise_wechat", "browser_push"];
  const channels = Array.isArray(input.channels) ? [...new Set(input.channels)] : [];
  if (!channels.length || channels.some(value => typeof value !== "string" || !allowedChannels.includes(value as NotificationChannel))) {
    throw new Error("At least one supported notification channel is required");
  }
  if (!channels.includes("in_app")) throw new Error("In-app notifications cannot be disabled");
  const minimum = input.minimum_external_severity;
  if (!['info', 'warning', 'critical'].includes(String(minimum))) throw new Error("Invalid minimum severity");
  const start = safeNotificationText(input.quiet_hours_start, 5);
  const end = safeNotificationText(input.quiet_hours_end, 5);
  parseClock(start);
  parseClock(end);
  const timezone = safeNotificationText(input.timezone, 64);
  new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  const escalation = Number(input.escalation_minutes);
  if (!Number.isInteger(escalation) || escalation < 5 || escalation > 1440) throw new Error("Escalation minutes must be between 5 and 1440");
  const messageMode = String(input.message_notification_mode ?? "unattended") as MessageNotificationMode;
  if (!['off', 'every_message', 'unattended', 'both'].includes(messageMode)) throw new Error("Invalid message notification mode");
  const unattendedMinutes = Number(input.unattended_minutes ?? 10);
  if (!Number.isInteger(unattendedMinutes) || unattendedMinutes < 1 || unattendedMinutes > 1440) {
    throw new Error("Unattended minutes must be between 1 and 1440");
  }
  const includePreview = input.include_message_preview ?? false;
  if (typeof includePreview !== "boolean") throw new Error("Message preview flag must be boolean");
  return {
    channels: channels as NotificationChannel[],
    minimum_external_severity: minimum as NotificationSeverity,
    quiet_hours_start: start,
    quiet_hours_end: end,
    timezone,
    escalation_minutes: escalation,
    message_notification_mode: messageMode,
    unattended_minutes: unattendedMinutes,
    include_message_preview: includePreview,
  };
}
