import { gatewayUrl } from "./console-session";

type Metric = { value: number | null; previous?: number | null; change_percent?: number | null; numerator?: number | null; denominator?: number | null; source: string };

export type OperationsMetrics = {
  definition_version: string;
  generated_at: string;
  period: { timezone: string; since: string; until: string; week_since: string };
  metrics: {
    conversations: Metric;
    served_customers: Metric;
    new_customers: Metric;
    first_response_seconds: Metric;
    resolution_rate: Metric;
    ai_adoption_rate: Metric;
  };
  attention: { outbound_failures: number; expiring_policies: number; expiring_documents?:number; failed_knowledge_jobs: number };
  onboarding: { ready_channels: number; active_knowledge_documents: number; active_members: number; processed_inbound_events: number };
  dependencies: { chatwoot_reports: "operational" | "degraded" };
};

export async function fetchOperationsMetrics(token: string): Promise<OperationsMetrics | undefined> {
  try {
    const response = await fetch(gatewayUrl("/api/v1/operations/metrics"), {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { data?: OperationsMetrics };
    return body.data;
  } catch {
    return undefined;
  }
}

export function formatDuration(seconds: number | null, locale: "zh" | "en" = "zh"): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)} ${locale === "en" ? "sec" : "秒"}`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} ${locale === "en" ? "min" : "分钟"}`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (locale === "en") return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
  return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
}

export function changeNote(change: number | null | undefined, locale: "zh" | "en" = "zh"): string {
  if (change === null || change === undefined) return locale === "en" ? "No comparable baseline yesterday" : "昨日无可比基线";
  if (change === 0) return locale === "en" ? "Unchanged from yesterday" : "与昨日持平";
  return locale === "en" ? `${change > 0 ? "+" : ""}${change}% vs yesterday` : `较昨日 ${change > 0 ? "+" : ""}${change}%`;
}
