export type ChatwootSummary = {
  conversations_count: number;
  avg_first_response_time: number | null;
  resolutions_count: number;
  previous?: {
    conversations_count?: number;
    avg_first_response_time?: number | null;
    resolutions_count?: number;
  };
};

export function safeRate(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function finiteCount(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function normalizeChatwootSummary(value: unknown): ChatwootSummary {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const previous = input.previous && typeof input.previous === "object" ? input.previous as Record<string, unknown> : {};
  const responseTime = input.avg_first_response_time === null ? null : Number(input.avg_first_response_time);
  const previousResponseTime = previous.avg_first_response_time === null ? null : Number(previous.avg_first_response_time);
  return {
    conversations_count: finiteCount(input.conversations_count),
    avg_first_response_time: responseTime !== null && Number.isFinite(responseTime) && responseTime >= 0 ? responseTime : null,
    resolutions_count: finiteCount(input.resolutions_count),
    previous: {
      conversations_count: finiteCount(previous.conversations_count),
      avg_first_response_time: previousResponseTime !== null && Number.isFinite(previousResponseTime) && previousResponseTime >= 0 ? previousResponseTime : null,
      resolutions_count: finiteCount(previous.resolutions_count)
    }
  };
}
