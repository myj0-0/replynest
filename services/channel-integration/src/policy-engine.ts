import { pool } from "./database.js";

export type RecommendationContext = {
  product_batch_id?: string;
  sku_id?: string;
  channel?: string;
  campaign_id?: string;
  customer_segment?: string;
  region?: string;
  purchase_time?: string;
  registration_time?: string;
  request_time?: string;
  action_time?: string;
  conversation_started_at?: string;
  order_id?: string;
};

type PolicyRow = {
  policy_id: string;
  name: string;
  policy_type: string;
  status: string;
  priority: number;
  valid_from: string;
  valid_until: string;
  timezone: string;
  eligibility_time_basis: keyof RecommendationContext;
  scope: Record<string, string[]>;
  conditions: Record<string, unknown>;
  decision: Record<string, unknown>;
  allowed_actions: string[];
  forbidden_actions: string[];
  reply_guidance: string;
  requires_human_approval: boolean;
  version: number;
};

export type PolicyCitation = PolicyRow & {
  evaluation_time: string;
  matched_conditions: Record<string, string>;
};

const scopeMap: Record<string, keyof RecommendationContext> = {
  product_batch_ids: "product_batch_id",
  sku_ids: "sku_id",
  channels: "channel",
  campaign_ids: "campaign_id",
  customer_segments: "customer_segment",
  regions: "region"
};

function matchesScope(scope: Record<string, string[]>, context: RecommendationContext): Record<string, string> | undefined {
  const matched: Record<string, string> = {};
  for (const [scopeKey, values] of Object.entries(scope)) {
    if (!Array.isArray(values) || values.length === 0) continue;
    const contextKey = scopeMap[scopeKey];
    const actual = contextKey ? context[contextKey] : undefined;
    if (!actual || !values.includes(actual)) return undefined;
    matched[scopeKey] = actual;
  }
  return matched;
}

function validDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export async function evaluatePolicies(tenantId: string, context: RecommendationContext, now = new Date()) {
  const result = await pool.query<PolicyRow>(
    `SELECT policy_id, name, policy_type, status, priority, valid_from, valid_until, timezone,
            eligibility_time_basis, scope, conditions, decision, allowed_actions, forbidden_actions,
            reply_guidance, requires_human_approval, version
       FROM temporary_policies WHERE tenant_id=$1 AND status='active'
       ORDER BY priority DESC, updated_at DESC`,
    [tenantId]
  );
  const matched: PolicyCitation[] = [];
  for (const policy of result.rows) {
    const basisValue = context[policy.eligibility_time_basis];
    const evaluationTime = validDate(basisValue) ?? (policy.eligibility_time_basis === "request_time" || policy.eligibility_time_basis === "action_time" ? now : undefined);
    if (!evaluationTime) continue;
    if (evaluationTime < new Date(policy.valid_from) || evaluationTime >= new Date(policy.valid_until)) continue;
    const matchedConditions = matchesScope(policy.scope, context);
    if (!matchedConditions) continue;
    matched.push({ ...policy, evaluation_time: evaluationTime.toISOString(), matched_conditions: matchedConditions });
  }

  const highestPriority = matched[0]?.priority;
  const highest = matched.filter(item => item.priority === highestPriority);
  const distinctDecisions = new Set(highest.map(item => JSON.stringify(item.decision)));
  const conflict = highest.length > 1 && distinctDecisions.size > 1;
  return {
    decision_time: now.toISOString(),
    matched,
    conflict,
    conflict_policy_ids: conflict ? highest.map(item => item.policy_id) : []
  };
}
