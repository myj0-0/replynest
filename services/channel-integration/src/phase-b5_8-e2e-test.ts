import { migrate, pool } from "./database.js";
import { requestSubscriptionChange } from "./subscription-changes.js";

process.env.PLATFORM_APPROVAL_MODE = "single";
await migrate();
const suffix = Date.now().toString(36), tenantId = `phase-b5-8-${suffix}`;
try {
  await pool.query(`INSERT INTO tenants(tenant_id,name,status) VALUES($1,'Phase B5.8','test')`, [tenantId]);
  const admin = await pool.query<{ admin_id: string }>(`INSERT INTO platform_admin_accounts(email,display_name,password_hash,role) VALUES($1,'Single owner','test','owner') RETURNING admin_id`, [`b58-${suffix}@example.invalid`]);
  await pool.query(`INSERT INTO tenant_subscriptions(tenant_id,plan_version_id,status,source,current_period_start,current_period_end,price_minor_snapshot,currency_snapshot,entitlement_snapshot) SELECT $1,plan_version_id,'active','free_baseline',NOW(),NULL,price_minor,currency,entitlement_rules FROM plan_catalog_versions WHERE plan_code='free' AND status='active'`, [tenantId]);
  const result = await requestSubscriptionChange(tenantId, "starter", admin.rows[0].admin_id, "Phase B5.8 单管理员定制套餐测试", { price_minor: 8800, seat_limit: 7, channel_limit: 2, ai_actions_monthly: 1234, knowledge_bytes: 536870912 });
  if (result.status !== "executed" || result.approval_mode !== "single" || !("subscription_id" in result)) throw new Error("single admin change was not executed");
  const state = await pool.query<{ status: string; same_actor: boolean; price_minor_snapshot: string; seat_limit: number; channel_limit: number; ai_actions_monthly: number; knowledge_bytes: string }>(`SELECT r.status,(r.requested_by=r.approved_by) AS same_actor,s.price_minor_snapshot,(s.entitlement_snapshot->>'seat_limit')::int AS seat_limit,(s.entitlement_snapshot->>'channel_limit')::int AS channel_limit,(s.entitlement_snapshot->>'ai_actions_monthly')::int AS ai_actions_monthly,s.entitlement_snapshot->>'knowledge_bytes' AS knowledge_bytes FROM subscription_change_requests r JOIN tenant_subscriptions s ON s.subscription_id=r.executed_subscription_id WHERE r.change_request_id=$1`, [result.change_request_id]);
  const row = state.rows[0];
  if (!row || row.status !== "executed" || !row.same_actor || Number(row.price_minor_snapshot) !== 8800 || row.seat_limit !== 7 || row.channel_limit !== 2 || row.ai_actions_monthly !== 1234 || Number(row.knowledge_bytes) !== 536870912) throw new Error("custom subscription snapshot mismatch");
  let immutable = false;
  try { await pool.query(`UPDATE tenant_subscriptions SET price_minor_snapshot=1 WHERE subscription_id=$1`, [result.subscription_id]); } catch { immutable = true; }
  if (!immutable) throw new Error("custom price snapshot was mutable");
  console.log(JSON.stringify({ phase: "B.5.8", single_admin_executed: true, same_actor_audited: true, custom_price: 8800, custom_seats: 7, custom_channels: 2, custom_ai_actions: 1234, custom_knowledge_bytes: 536870912, snapshot_immutable: true }));
} finally { await pool.end(); }
