import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "./database.js";
import { requiredEnv, sendJson } from "./shared.js";
import { normalizeChatwootSummary, percentChange, safeRate, type ChatwootSummary } from "./operations-metrics-core.js";
import { OPERATIONS_COUNTS_SQL } from './operations-metrics-query.js';

type MetricsAuth = {
  tenant_id: string;
  role: "tenant_admin" | "supervisor" | "agent";
};

function finiteCount(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

async function chatwootSummary(accountId: number, since: number, until: number, timezoneOffset: number): Promise<ChatwootSummary> {
  const baseUrl = requiredEnv("CHATWOOT_BASE_URL").replace(/\/$/, "");
  const url = new URL(`${baseUrl}/api/v2/accounts/${accountId}/reports/summary`);
  url.searchParams.set("since", String(since));
  url.searchParams.set("until", String(until));
  url.searchParams.set("type", "account");
  url.searchParams.set("timezone_offset", String(timezoneOffset));
  const response = await fetch(url, {
    headers: { api_access_token: requiredEnv("CHATWOOT_API_ACCESS_TOKEN"), "x-forwarded-proto": "https" },
    signal: AbortSignal.timeout(7_000)
  });
  if (!response.ok) throw new Error(`Chatwoot reports returned ${response.status}`);
  return normalizeChatwootSummary(await response.json());
}

export async function handleOperationsMetricsApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  auth: MetricsAuth,
  requestId: string
): Promise<boolean> {
  if (request.method !== "GET" || url.pathname !== "/api/v1/operations/metrics") return false;
  if (auth.role === "agent") {
    sendJson(response, 403, { request_id: requestId, error: { code: "forbidden", message: "仅企业管理员和客服主管可查看企业汇总指标" } });
    return true;
  }

  const tenant = await pool.query<{
    timezone: string;
    chatwoot_account_id: string;
    day_start: Date;
    day_end: Date;
    current_at: Date;
    previous_day_start: Date;
    week_start: Date;
    timezone_offset: string;
  }>(
    `SELECT timezone,chatwoot_account_id,
            (date_trunc('day',NOW() AT TIME ZONE timezone) AT TIME ZONE timezone) AS day_start,
            ((date_trunc('day',NOW() AT TIME ZONE timezone)+INTERVAL '1 day') AT TIME ZONE timezone) AS day_end,
            NOW() AS current_at,
            ((date_trunc('day',NOW() AT TIME ZONE timezone)-INTERVAL '1 day') AT TIME ZONE timezone) AS previous_day_start,
            (date_trunc('week',NOW() AT TIME ZONE timezone) AT TIME ZONE timezone) AS week_start,
            EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE timezone)-(NOW() AT TIME ZONE 'UTC')))/3600 AS timezone_offset
       FROM tenants WHERE tenant_id=$1`,
    [auth.tenant_id]
  );
  if (!tenant.rows[0]?.chatwoot_account_id) {
    sendJson(response, 409, { request_id: requestId, error: { code: "chatwoot_mapping_required", message: "企业尚未映射客服工作台" } });
    return true;
  }
  const period = tenant.rows[0];
  const counts = await pool.query<{
    served_customers: string;
    new_customers: string;
    previous_new_customers: string;
    ai_displayed: string;
    ai_accepted: string;
    outbound_failures: string;
    expiring_policies: string;
    expiring_documents:string;
    failed_knowledge_jobs: string;
    active_knowledge_documents: string;
    active_members: string;
    processed_inbound_events: string;
    pending_inbound_events: string;
    dead_inbound_events: string;
    ready_channels: string;
  }>(
    OPERATIONS_COUNTS_SQL,
    [auth.tenant_id, period.day_start, period.day_end, period.previous_day_start, period.week_start]
  );
  const row = counts.rows[0];
  const local = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, finiteCount(value)])) as Record<keyof typeof row, number>;

  let chatwoot: { available: true; summary: ChatwootSummary } | { available: false; error: "temporarily_unavailable" };
  try {
    chatwoot = {
      available: true,
      summary: await chatwootSummary(
        Number(period.chatwoot_account_id),
        Math.floor(period.day_start.getTime() / 1000),
        Math.floor(period.current_at.getTime() / 1000),
        Number(period.timezone_offset)
      )
    };
  } catch (error) {
    console.warn("Operations metrics Chatwoot report unavailable", error instanceof Error ? error.message : String(error));
    chatwoot = { available: false, error: "temporarily_unavailable" };
  }

  const conversations = chatwoot.available ? chatwoot.summary.conversations_count : null;
  const previousConversations = chatwoot.available ? chatwoot.summary.previous?.conversations_count ?? 0 : null;
  const resolutions = chatwoot.available ? chatwoot.summary.resolutions_count : null;
  sendJson(response, 200, {
    request_id: requestId,
    data: {
      definition_version: "operations-v1",
      generated_at: new Date().toISOString(),
      period: { timezone: period.timezone, since: period.day_start, until: period.current_at, week_since: period.week_start },
      metrics: {
        conversations: { value: conversations, previous: previousConversations, change_percent: conversations === null || previousConversations === null ? null : percentChange(conversations, previousConversations), source: "chatwoot_reports_v2" },
        served_customers: { value: local.served_customers, source: "replynest_outbound_deliveries" },
        new_customers: { value: local.new_customers, previous: local.previous_new_customers, change_percent: percentChange(local.new_customers, local.previous_new_customers), source: "replynest_customers" },
        first_response_seconds: { value: chatwoot.available ? chatwoot.summary.avg_first_response_time : null, source: "chatwoot_reports_v2" },
        resolution_rate: { value: conversations === null || resolutions === null ? null : safeRate(resolutions, conversations), numerator: resolutions, denominator: conversations, source: "chatwoot_reports_v2" },
        ai_adoption_rate: { value: safeRate(local.ai_accepted, local.ai_displayed), numerator: local.ai_accepted, denominator: local.ai_displayed, source: "replynest_ai_recommendations" }
      },
      attention: { outbound_failures: local.outbound_failures, inbound_pending: local.pending_inbound_events, inbound_dead: local.dead_inbound_events, expiring_policies: local.expiring_policies, expiring_documents:local.expiring_documents, failed_knowledge_jobs: local.failed_knowledge_jobs },
      onboarding: { ready_channels: local.ready_channels, active_knowledge_documents: local.active_knowledge_documents, active_members: local.active_members, processed_inbound_events: local.processed_inbound_events },
      dependencies: { chatwoot_reports: chatwoot.available ? "operational" : "degraded" }
    }
  });
  return true;
}
