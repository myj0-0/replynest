export type CampaignAudienceFilter = { mode: "all" | "tags_any"; tags: string[] };
export type CampaignCancelCondition = { type: "none" } | { type: "customer_attribute_equals"; key: string; value: string };

export function normalizeCampaignInput(input: Record<string, unknown>) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const content = typeof input.content === "string" ? input.content.trim() : "";
  const channel = typeof input.channel === "string" ? input.channel : "";
  if (name.length < 2 || name.length > 80) throw new Error("invalid_campaign_name");
  if (!content || content.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)) throw new Error("invalid_campaign_content");
  if (!["wechat_official_account", "mock-wechat"].includes(channel)) throw new Error("invalid_campaign_channel");
  const source = input.audience_filter && typeof input.audience_filter === "object" ? input.audience_filter as Record<string, unknown> : {};
  const mode = source.mode === "tags_any" ? "tags_any" : source.mode === "all" ? "all" : null;
  if (!mode) throw new Error("invalid_audience_filter");
  const tags = mode === "tags_any" && Array.isArray(source.tags)
    ? [...new Set(source.tags.map(String).map(tag => tag.trim()).filter(Boolean))]
    : [];
  if (tags.length > 10 || tags.some(tag => tag.length > 30)) throw new Error("invalid_audience_filter");
  if (mode === "tags_any" && tags.length === 0) throw new Error("invalid_audience_filter");
  return { name, content, channel, audience_filter: { mode, tags } as CampaignAudienceFilter };
}

export function matchesCampaignAudience(attributes: unknown, filter: CampaignAudienceFilter): boolean {
  if (filter.mode === "all") return true;
  const record = attributes && typeof attributes === "object" ? attributes as Record<string, unknown> : {};
  const tags = Array.isArray(record.tags) ? record.tags.map(String) : [];
  return filter.tags.some(tag => tags.includes(tag));
}

export function campaignRecipientDecision(consentStatus: string | null | undefined, syncStatus: string) {
  if (syncStatus !== "synced") return { eligible: false, suppression_reason: "identity_not_ready" as const };
  if (consentStatus === "withdrawn") return { eligible: false, suppression_reason: "unsubscribed" as const };
  if (consentStatus !== "granted") return { eligible: false, suppression_reason: "consent_missing" as const };
  return { eligible: true, suppression_reason: null };
}

function validTimeZone(value: string) {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date()); return true; } catch { return false; }
}

function minuteOfDay(value: string) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("invalid_quiet_hours");
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function normalizeCampaignSchedule(input: Record<string, unknown>, now = new Date()) {
  const scheduledAt = new Date(String(input.scheduled_at ?? ""));
  if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() < now.getTime() - 60_000 || scheduledAt.getTime() > now.getTime() + 366 * 86_400_000) throw new Error("invalid_scheduled_at");
  const timezone = typeof input.timezone === "string" ? input.timezone : "";
  if (!timezone || timezone.length > 64 || !validTimeZone(timezone)) throw new Error("invalid_timezone");
  const quietHoursStart = typeof input.quiet_hours_start === "string" ? input.quiet_hours_start : "22:00";
  const quietHoursEnd = typeof input.quiet_hours_end === "string" ? input.quiet_hours_end : "08:00";
  minuteOfDay(quietHoursStart); minuteOfDay(quietHoursEnd);
  const rateLimitPerMinute = Number(input.rate_limit_per_minute ?? 20);
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1 || rateLimitPerMinute > 100) throw new Error("invalid_rate_limit");
  const raw = input.cancel_condition && typeof input.cancel_condition === "object" ? input.cancel_condition as Record<string, unknown> : { type: "none" };
  let cancelCondition: CampaignCancelCondition;
  if (raw.type === "none") cancelCondition = { type: "none" };
  else if (raw.type === "customer_attribute_equals" && typeof raw.key === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(raw.key) && typeof raw.value === "string" && raw.value.length <= 100) cancelCondition = { type: raw.type, key: raw.key, value: raw.value };
  else throw new Error("invalid_cancel_condition");
  return { scheduled_at: scheduledAt, timezone, quiet_hours_start: quietHoursStart, quiet_hours_end: quietHoursEnd, rate_limit_per_minute: rateLimitPerMinute, cancel_condition: cancelCondition };
}

export function localMinuteOfDay(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find(item => item.type === "hour")?.value);
  const minute = Number(parts.find(item => item.type === "minute")?.value);
  return hour * 60 + minute;
}

export function isCampaignQuietTime(now: Date, timezone: string, start: string, end: string) {
  const current = localMinuteOfDay(now, timezone), startMinute = minuteOfDay(start), endMinute = minuteOfDay(end);
  if (startMinute === endMinute) return false;
  return startMinute < endMinute ? current >= startMinute && current < endMinute : current >= startMinute || current < endMinute;
}

export function nextCampaignAllowedAt(now: Date, timezone: string, start: string, end: string) {
  if (!isCampaignQuietTime(now, timezone, start, end)) return now;
  const candidate = new Date(now);
  for (let index = 0; index < 1_441; index += 1) {
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
    if (!isCampaignQuietTime(candidate, timezone, start, end)) return candidate;
  }
  throw new Error("quiet_hours_resolution_failed");
}

export function matchesCampaignCancelCondition(attributes: unknown, condition: CampaignCancelCondition) {
  if (condition.type === "none") return false;
  const record = attributes && typeof attributes === "object" ? attributes as Record<string, unknown> : {};
  return String(record[condition.key] ?? "") === condition.value;
}

export function campaignDeliveryRetrySeconds(attemptCount: number) {
  return Math.min(300, 5 * 2 ** Math.max(0, attemptCount - 1));
}
