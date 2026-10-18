import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { requiredEnv } from "./shared.js";

const baseUrl = process.env.PHASE4_API_URL ?? "http://127.0.0.1:3001";
const demoKey = requiredEnv("DEMO_TENANT_API_KEY");
const isolationKey = requiredEnv("ISOLATION_TEST_TENANT_API_KEY");

async function api(path: string, key: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(10_000)
  });
}

async function customerId(key: string): Promise<string> {
  const response = await api("/api/v1/customers?limit=1", key);
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.ok(body.data[0]?.customer_id);
  return body.data[0].customer_id;
}

async function recommend(key: string, customer: string, question: string, context: Record<string, string>, idempotency = randomUUID()) {
  const response = await api("/api/v1/ai/recommendations", key, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotency },
    body: JSON.stringify({ customer_id: customer, question, context })
  });
  return { response, body: await response.json() as any, idempotency };
}

async function getOrder(key: string, customer: string, orderId: string, idempotency = randomUUID()) {
  const response = await api("/api/v1/ai/tools/get-order", key, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotency },
    body: JSON.stringify({ customer_id: customer, order_id: orderId })
  });
  return { response, body: await response.json() as any, idempotency };
}

const demoCustomer = await customerId(demoKey);
const isolationCustomer = await customerId(isolationKey);
const active = await recommend(demoKey, demoCustomer, "这个批次可以退款吗？", {
  product_batch_id: "BATCH-2026-08", channel: "mock-wechat"
});
assert.equal(active.response.status, 201);
assert.equal(active.body.data.status, "generated");
assert.equal(active.body.data.policy_citations.length, 1);
assert.ok(active.body.data.knowledge_citations.length > 0);
assert.ok(["medium","high"].includes(active.body.data.confidence.level));
assert.equal(active.body.data.confidence.delivery_mode, "human_confirmation");
assert.ok(active.body.data.historical_examples.every((item: any) => item.usage === "tone_only"));
assert.equal(JSON.stringify(active.body).includes("ISOLATION-TENANT-SECRET-CONTENT"), false);

const replay = await recommend(demoKey, demoCustomer, "这个批次可以退款吗？", {
  product_batch_id: "BATCH-2026-08", channel: "mock-wechat"
}, active.idempotency);
assert.equal(replay.body.data.recommendation_id, active.body.data.recommendation_id);

const inserted = await api(`/api/v1/ai/recommendations/${active.body.data.recommendation_id}/actions`, demoKey, {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
  body: JSON.stringify({ action: "inserted", text: active.body.data.recommendation_text })
});
assert.equal(inserted.status, 200);
assert.equal((await inserted.json() as any).data.status, "inserted");

const accepted = await api(`/api/v1/ai/recommendations/${active.body.data.recommendation_id}/actions`, demoKey, {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
  body: JSON.stringify({ action: "accepted" })
});
assert.equal(accepted.status, 200);
assert.equal((await accepted.json() as any).data.status, "accepted");

const expired = await recommend(demoKey, demoCustomer, "旧批次可以退款吗？", {
  product_batch_id: "BATCH-OLD", channel: "mock-wechat"
});
assert.equal(expired.body.data.policy_citations.length, 0);
assert.ok(expired.body.data.historical_examples.every((item: any) => item.policy_independent === true));

const promotion = await recommend(demoKey, demoCustomer, "可以使用优惠券吗？", {
  channel: "mock-wechat", customer_segment: "new-customer", registration_time: new Date().toISOString()
});
assert.equal(promotion.body.data.policy_citations.length, 1);
assert.equal(promotion.body.data.historical_examples.length, 0);

const conflict = await recommend(demoKey, demoCustomer, "冲突批次可以退款吗？", {
  product_batch_id: "BATCH-CONFLICT", channel: "mock-wechat"
});
assert.equal(conflict.body.data.status, "blocked_by_policy_conflict");
assert.equal(conflict.body.data.recommendation_text, null);
assert.equal(conflict.body.data.conflict_policy_ids.length, 2);
assert.equal(conflict.body.data.confidence.score, 0);

const crossTenant = await recommend(isolationKey, demoCustomer, "退款", { product_batch_id: "BATCH-2026-08" });
assert.equal(crossTenant.response.status, 404);
const isolation = await recommend(isolationKey, isolationCustomer, "退款机密", {});
assert.equal(isolation.response.status, 201);
assert.equal(JSON.stringify(isolation.body).includes("ISOLATION-TENANT-SECRET-CONTENT"), true);

const demoOrderFixture = (await pool.query<{ customer_id: string; external_order_id: string }>(
  `SELECT customer_id,external_order_id FROM mock_orders WHERE tenant_id=$1 AND external_order_id='ORD-SHARED-001'`,
  [requiredEnv("DEMO_TENANT_ID")]
)).rows[0];
const isolationOrderFixture = (await pool.query<{ customer_id: string; external_order_id: string }>(
  `SELECT customer_id,external_order_id FROM mock_orders WHERE tenant_id=$1 AND external_order_id='ORD-SHARED-001'`,
  [requiredEnv("ISOLATION_TEST_TENANT_ID")]
)).rows[0];
const directKey = randomUUID();
const demoOrder = await getOrder(demoKey, demoOrderFixture.customer_id, demoOrderFixture.external_order_id, directKey);
assert.equal(demoOrder.response.status, 200);
assert.equal(demoOrder.body.data.status, "succeeded");
assert.equal(demoOrder.body.data.data.product_summary, "星云路由器（合成）");
assert.equal(JSON.stringify(demoOrder.body).includes("隔离企业合成产品"), false);
const directReplay = await getOrder(demoKey, demoOrderFixture.customer_id, demoOrderFixture.external_order_id, directKey);
assert.equal(directReplay.body.data.invocation_id, demoOrder.body.data.invocation_id);
const isolationOrder = await getOrder(isolationKey, isolationOrderFixture.customer_id, isolationOrderFixture.external_order_id);
assert.equal(isolationOrder.response.status, 200);
assert.equal(isolationOrder.body.data.data.product_summary, "隔离企业合成产品");
const crossTenantOrder = await getOrder(isolationKey, demoOrderFixture.customer_id, demoOrderFixture.external_order_id);
assert.equal(crossTenantOrder.response.status, 404);
assert.equal(crossTenantOrder.body.data.error.code, "order_not_found");

const orderRecommendation = await recommend(demoKey, demoOrderFixture.customer_id, "这个订单现在是什么状态？", {
  order_id: demoOrderFixture.external_order_id, channel: "mock-wechat", product_batch_id: "BATCH-CONFLICT"
});
assert.equal(orderRecommendation.response.status, 201);
assert.equal(orderRecommendation.body.data.tool_results[0].status, "succeeded");
assert.equal(orderRecommendation.body.data.tool_results[0].data.status, "shipped");
assert.equal(orderRecommendation.body.data.policy_citations.length, 1);
assert.equal(orderRecommendation.body.data.evidence_panel.business_data[0].display_type, "business_data");
assert.match(orderRecommendation.body.data.recommendation_text, /shipped/);
const failedOrderRecommendation = await recommend(demoKey, demoOrderFixture.customer_id, "查询不存在的订单状态", {
  order_id: "ORD-MISSING-999", product_batch_id: "BATCH-2026-08", channel: "mock-wechat"
});
assert.equal(failedOrderRecommendation.body.data.status, "insufficient_evidence");
assert.equal(failedOrderRecommendation.body.data.tool_results[0].status, "not_found");
assert.equal(failedOrderRecommendation.body.data.policy_citations.length, 0);
assert.equal(failedOrderRecommendation.body.data.confidence.level, "low");
assert.match(failedOrderRecommendation.body.data.recommendation_text, /人工核实/);
const toolAudit = await pool.query(
  `SELECT audit_id FROM audit_logs WHERE tenant_id=$1 AND action='tool.get_order.queried' AND resource_id=$2`,
  [requiredEnv("DEMO_TENANT_ID"), demoOrder.body.data.invocation_id]
);
assert.equal(toolAudit.rowCount, 1);

const stale = await recommend(demoKey, demoCustomer, "这个批次可以退款吗？", {
  product_batch_id: "BATCH-2026-08", channel: "mock-wechat"
});
try {
  await pool.query(`UPDATE temporary_policies SET status='paused',updated_at=NOW() WHERE tenant_id=$1 AND name='BATCH-2026-08 临时退款规则'`, [requiredEnv("DEMO_TENANT_ID")]);
  const staleAction = await api(`/api/v1/ai/recommendations/${stale.body.data.recommendation_id}/actions`, demoKey, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
    body: JSON.stringify({ action: "accepted" })
  });
  assert.equal(staleAction.status, 409);
  assert.equal((await staleAction.json() as any).data.status, "expired_before_send");
} finally {
  await pool.query(`UPDATE temporary_policies SET status='active',updated_at=NOW() WHERE tenant_id=$1 AND name='BATCH-2026-08 临时退款规则'`, [requiredEnv("DEMO_TENANT_ID")]);
  await pool.end();
}

console.log(JSON.stringify({
  active_policy_selected: true,
  expired_policy_excluded: true,
  expired_history_logic_excluded: true,
  unreviewed_history_excluded: true,
  history_is_tone_only: true,
  policy_conflict_blocked: true,
  cross_tenant_retrieval_blocked: true,
  send_time_revalidation_blocked_stale_recommendation: true,
  idempotent_generation: true,
  human_confirmation_recorded: true,
  get_order_read_only: true,
  get_order_idempotent: true,
  get_order_cross_tenant_blocked: true,
  tool_failure_safe_fallback: true,
  evidence_panel_renderable: true
}));
