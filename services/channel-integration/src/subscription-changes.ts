import type { PoolClient } from "pg";
import {adminRecordList} from './admin-record-lists.js';
import { pool } from "./database.js";
import { validateEntitlements, type EntitlementRules } from "./subscription-core.js";
import { platformApprovalMode, type PlatformApprovalMode } from "./approval-mode.js";
import { manualValidity, snapshotValidity } from './subscription-validity.js';

type ChangeRow = {
  change_request_id: string;
  tenant_id: string;
  current_subscription_id: string;
  target_plan_version_id: string;
  requested_by: string;
  requested_price_minor: string | null;
  requested_currency: "CNY";
  requested_entitlement_snapshot: EntitlementRules;
  approval_mode: PlatformApprovalMode;
  status: string;
};

export type SubscriptionOverrides = {
  validity_mode?: 'days' | 'unlimited';
  validity_days?: number | string;
  price_minor?: number;
  seat_limit?: number;
  channel_limit?: number;
  customer_limit?: number;
  ai_actions_monthly?: number;
  knowledge_bytes?: number;
  automation_rule_limit?: number;
  qr_code_limit?: number;
  audit_retention_days?: number;
};

function validOverride(value: number | undefined, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_${key}`);
  return value;
}

function applyOverrides(base: EntitlementRules, overrides: SubscriptionOverrides): EntitlementRules {
  const next: Record<string, unknown> = { ...base };
  for (const key of ["seat_limit", "channel_limit", "customer_limit", "ai_actions_monthly", "knowledge_bytes", "automation_rule_limit", "qr_code_limit", "audit_retention_days"] as const) {
    const value = validOverride(overrides[key], key);
    if (value !== undefined) next[key] = value;
  }
  return validateEntitlements(next);
}

async function executePending(client: PoolClient, item: ChangeRow, adminId: string, reason: string) {
  if (item.approval_mode === "dual" && item.requested_by === adminId) throw new Error("second_admin_required");
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`subscription-change:${item.tenant_id}`]);
  if((await client.query(`SELECT 1 FROM payment_refund_requests WHERE tenant_id=$1 AND status NOT IN ('succeeded','rejected')`,[item.tenant_id])).rowCount)throw new Error('refund_in_progress');
  const current = await client.query(`SELECT s.*,p.plan_code,(s.current_period_end IS NULL OR s.current_period_end>NOW()) AS unexpired FROM tenant_subscriptions s JOIN plan_catalog_versions p USING(plan_version_id) WHERE s.tenant_id=$1 AND s.subscription_id=$2 AND s.status IN ('active','trialing','past_due') FOR UPDATE OF s`, [item.tenant_id, item.current_subscription_id]);
  if (!current.rows[0]) throw new Error("subscription_changed_since_request");
  const plan = await client.query(`SELECT plan_version_id FROM plan_catalog_versions WHERE plan_version_id=$1 AND status='active'`, [item.target_plan_version_id]);
  if (!plan.rows[0]) throw new Error("target_plan_inactive");
  const entitlements = validateEntitlements(item.requested_entitlement_snapshot);
  const validity = snapshotValidity(item.requested_entitlement_snapshot);
  // Changing plan limits must not mint a fresh monthly allowance. Preserve the
  // unexpired non-free subscription's original point-cycle anchor internally.
  const previous=current.rows[0];
  const snapshot=previous.plan_code!=='free'&&previous.unexpired?{...entitlements,ai_cycle_anchor:previous.entitlement_snapshot.ai_cycle_anchor??new Date(previous.current_period_start).toISOString()}:entitlements;
  await client.query(`UPDATE tenant_subscriptions SET status='canceled',updated_at=NOW() WHERE subscription_id=$1`, [item.current_subscription_id]);
  const inserted = await client.query<{ subscription_id: string; current_period_end: Date | null }>(`INSERT INTO tenant_subscriptions(tenant_id,plan_version_id,status,source,current_period_start,current_period_end,price_minor_snapshot,currency_snapshot,entitlement_snapshot) VALUES($1,$2,'active','manual',NOW(),CASE WHEN $6::int IS NULL THEN NULL ELSE ((NOW() AT TIME ZONE 'Asia/Shanghai')+($6::int*INTERVAL '1 day')) AT TIME ZONE 'Asia/Shanghai' END,$3,$4,$5) RETURNING subscription_id,current_period_end`, [item.tenant_id, item.target_plan_version_id, item.requested_price_minor, item.requested_currency, JSON.stringify(snapshot), validity?.days ?? null]);
  await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,event_key,facts) VALUES($1,$2,'plan_changed','platform_admin',$3,jsonb_build_object('change_request_id',$4::text,'previous_subscription_id',$5::text,'approval_mode',$6::text,'price_minor',$7::bigint))`, [item.tenant_id, inserted.rows[0].subscription_id, `manual-change:${item.change_request_id}`, item.change_request_id, item.current_subscription_id, item.approval_mode, item.requested_price_minor]);
  await client.query(`UPDATE subscription_change_requests SET status='executed',approved_by=$2,approval_reason=$3,executed_subscription_id=$4,decided_at=NOW(),executed_at=NOW(),updated_at=NOW() WHERE change_request_id=$1`, [item.change_request_id, adminId, reason, inserted.rows[0].subscription_id]);
  return { change_request_id: item.change_request_id, subscription_id: inserted.rows[0].subscription_id, current_period_end: inserted.rows[0].current_period_end, status: "executed", approval_mode: item.approval_mode };
}

export async function listSubscriptionChanges(params=new URLSearchParams()) {
  const [requests, plans] = await Promise.all([
    adminRecordList('subscriptions',params),
    pool.query(`SELECT plan_version_id,plan_code,name,version,price_minor,currency,entitlement_rules FROM plan_catalog_versions WHERE status='active' ORDER BY CASE plan_code WHEN 'free' THEN 0 WHEN 'starter' THEN 1 WHEN 'professional' THEN 2 ELSE 3 END`)
  ]);
  return { requests: requests.items, page:requests.page,has_more:requests.has_more, plans: plans.rows.map(row => ({ ...row, entitlement_rules: validateEntitlements(row.entitlement_rules) })), approval_mode: platformApprovalMode() };
}

export async function requestSubscriptionChange(tenantId: string, targetPlanCode: string, adminId: string, reason: string, overrides: SubscriptionOverrides = {}) {
  if (reason.trim().length < 10) throw new Error("reason_required");
  if (overrides.price_minor !== undefined) validOverride(overrides.price_minor, "price_minor");
  const validity = manualValidity(overrides.validity_mode, overrides.validity_days);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`subscription-change:${tenantId}`]);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`wallet:${tenantId}`]);
    const current = await client.query<{ subscription_id: string }>(`SELECT s.subscription_id FROM tenant_subscriptions s WHERE s.tenant_id=$1 AND s.status IN ('active','trialing','past_due') FOR UPDATE OF s`, [tenantId]);
    const plan = await client.query<{ plan_version_id: string; price_minor: string | null; currency: "CNY"; entitlement_rules: EntitlementRules }>(`SELECT plan_version_id,price_minor,currency,entitlement_rules FROM plan_catalog_versions WHERE plan_code=$1 AND status='active'`, [targetPlanCode]);
    if (!current.rows[0] || !plan.rows[0]) throw new Error("subscription_or_plan_not_found");
    const approvalMode = platformApprovalMode();
    const entitlements = { ...applyOverrides(validateEntitlements(plan.rows[0].entitlement_rules), overrides), manual_validity: validity };
    const priceMinor = overrides.price_minor === undefined ? plan.rows[0].price_minor : overrides.price_minor;
    const inserted = await client.query<ChangeRow>(`INSERT INTO subscription_change_requests(tenant_id,current_subscription_id,target_plan_version_id,requested_by,request_reason,requested_price_minor,requested_currency,requested_entitlement_snapshot,approval_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING change_request_id,tenant_id,current_subscription_id,target_plan_version_id,requested_by,requested_price_minor,requested_currency,requested_entitlement_snapshot,approval_mode,status`, [tenantId, current.rows[0].subscription_id, plan.rows[0].plan_version_id, adminId, reason.trim(), priceMinor, plan.rows[0].currency, JSON.stringify(entitlements), approvalMode]);
    const result = approvalMode === "single" ? await executePending(client, inserted.rows[0], adminId, "单管理员模式：提交后立即执行") : inserted.rows[0];
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function approveSubscriptionChange(requestId: string, adminId: string, reason: string) {
  if (reason.trim().length < 10) throw new Error("reason_required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenant = (await client.query(`SELECT tenant_id FROM subscription_change_requests WHERE change_request_id=$1`, [requestId])).rows[0];
    if (!tenant) throw new Error('change_not_pending');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`subscription-change:${tenant.tenant_id}`]);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`wallet:${tenant.tenant_id}`]);
    const request = await client.query<ChangeRow>(`SELECT change_request_id,tenant_id,current_subscription_id,target_plan_version_id,requested_by,requested_price_minor,requested_currency,requested_entitlement_snapshot,approval_mode,status FROM subscription_change_requests WHERE change_request_id=$1 FOR UPDATE`, [requestId]);
    const item = request.rows[0];
    if (!item || item.status !== "pending_approval") throw new Error("change_not_pending");
    const result = await executePending(client, item, adminId, reason.trim());
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function rejectSubscriptionChange(requestId: string, adminId: string, reason: string) {
  if (reason.trim().length < 10) throw new Error("reason_required");
  const sameAdminClause = platformApprovalMode() === "dual" ? "AND requested_by<>$2" : "";
  const result = await pool.query(`UPDATE subscription_change_requests SET status='rejected',approved_by=$2,approval_reason=$3,decided_at=NOW(),updated_at=NOW() WHERE change_request_id=$1 AND status='pending_approval' ${sameAdminClause} RETURNING change_request_id,status`, [requestId, adminId, reason.trim()]);
  if (!result.rows[0]) throw new Error("approval_policy_or_pending_required");
  return result.rows[0];
}
