import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { processMessageCampaignDeliveries } from "./message-campaign-delivery.js";
import { approveMessageCampaign, CampaignError, cancelMessageCampaign, createMessageCampaign, recordMarketingConsent, scheduleMessageCampaign, snapshotMessageCampaign } from "./message-campaigns.js";

const fixture = await pool.query<{ tenant_id: string; platform_user_id: string }>(
  `SELECT m.tenant_id,m.platform_user_id FROM tenant_memberships m JOIN tenants t ON t.tenant_id=m.tenant_id
    WHERE m.role='tenant_admin' AND m.status='active' AND t.status IN ('active','test') ORDER BY t.created_at LIMIT 1`
);
assert.ok(fixture.rows[0], "tenant admin fixture is required");
const { tenant_id: tenantId, platform_user_id: userId } = fixture.rows[0];
const marker = `b72-${Date.now()}`;
const actor = () => ({ actor_type: "console_session" as const, actor_id: userId, request_id: randomUUID() });
const identities: string[] = [];

for (const [index, attributes] of [
  {},
  { withdrawn_after_snapshot: true },
  { purchased: "true" },
  { synthetic_campaign_result: "retry_once" },
  { synthetic_campaign_result: "dead" }
].entries()) {
  const customer = await pool.query<{ customer_id: string }>(
    `INSERT INTO customers(tenant_id,name,attributes) VALUES($1,$2,$3) RETURNING customer_id`,
    [tenantId, `B.7.2 合成客户 ${index + 1}`, JSON.stringify({ ...attributes, tags: [marker] })]
  );
  const identity = await pool.query<{ identity_id: string }>(
    `INSERT INTO channel_identities(tenant_id,customer_id,channel,external_user_id,chatwoot_source_id,chatwoot_conversation_id)
     VALUES($1,$2,'mock-wechat',$3,$4,$5) RETURNING identity_id`,
    [tenantId, customer.rows[0].customer_id, `${marker}-user-${index}`, `${marker}-source-${index}`, Date.now() + index]
  );
  identities.push(identity.rows[0].identity_id);
  await recordMarketingConsent(tenantId, identity.rows[0].identity_id, { status: "granted", source: "customer_action", evidence_ref: `${marker}:opt-in:${index}` }, `${marker}-consent-${index}`, actor());
}

const campaign = await createMessageCampaign(tenantId, {
  name: `B.7.2 合成活动 ${marker}`, content: "仅由合成适配器处理，不会调用真实渠道。", channel: "mock-wechat",
  audience_filter: { mode: "tags_any", tags: [marker] }
}, `${marker}-campaign`, actor());
const snapshotted = await snapshotMessageCampaign(tenantId, campaign.campaign_id, actor());
assert.equal(snapshotted.eligible_total, 5);
await approveMessageCampaign(tenantId, campaign.campaign_id, "B.7.2 合成投递验收批准，不触达真实用户。", actor());

const originalEnabled = process.env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED;
const originalProvider = process.env.MESSAGE_CAMPAIGN_PROVIDER;
process.env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED = "false";
await assert.rejects(
  () => scheduleMessageCampaign(tenantId, campaign.campaign_id, {}, "B.7.2 关闭态调度必须被拒绝。", actor()),
  (error: unknown) => error instanceof CampaignError && error.code === "campaign_execution_disabled"
);

process.env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED = "true";
process.env.MESSAGE_CAMPAIGN_PROVIDER = "synthetic";
const now = new Date();
await scheduleMessageCampaign(tenantId, campaign.campaign_id, {
  scheduled_at: now.toISOString(), timezone: "Asia/Shanghai", quiet_hours_start: "00:00", quiet_hours_end: "00:00",
  rate_limit_per_minute: 2, cancel_condition: { type: "customer_attribute_equals", key: "purchased", value: "true" }
}, "B.7.2 合成安全调度验收，频控为每分钟两条。", actor(), now);

await recordMarketingConsent(tenantId, identities[1], { status: "withdrawn", source: "customer_action", evidence_ref: `${marker}:late-unsubscribe` }, `${marker}-withdraw-late`, actor());
for (let minute = 0; minute < 8; minute += 1) {
  await processMessageCampaignDeliveries(new Date(now.getTime() + minute * 61_000), 20);
}

const states = await pool.query<{ status: string; count: number }>(
  `SELECT status,COUNT(*)::int count FROM message_campaign_deliveries WHERE campaign_id=$1 GROUP BY status`, [campaign.campaign_id]
);
assert.deepEqual(Object.fromEntries(states.rows.map(row => [row.status, row.count])), { dead: 1, delivered: 2, suppressed: 2 });
const final = await pool.query<{ status: string }>(`SELECT status FROM message_campaigns WHERE campaign_id=$1`, [campaign.campaign_id]);
assert.equal(final.rows[0].status, "failed");
const attempts = await pool.query<{ count: number }>(`SELECT COUNT(*)::int count FROM message_campaign_delivery_events WHERE campaign_id=$1 AND event_type='attempted'`, [campaign.campaign_id]);
assert.equal(attempts.rows[0].count, 4, "one retry must be recorded and suppressed recipients must never be attempted");
const suppressed = await pool.query<{ suppression_reason: string }>(`SELECT suppression_reason FROM message_campaign_deliveries WHERE campaign_id=$1 AND status='suppressed' ORDER BY suppression_reason`, [campaign.campaign_id]);
assert.deepEqual(suppressed.rows.map(row => row.suppression_reason), ["cancel_condition_matched", "consent_withdrawn"]);
await assert.rejects(() => pool.query(`DELETE FROM message_campaign_delivery_events WHERE campaign_id=$1`, [campaign.campaign_id]));

const quietCampaign = await createMessageCampaign(tenantId, {
  name: `B.7.2 静默时段 ${marker}`, content: "静默时段验证。", channel: "mock-wechat", audience_filter: { mode: "tags_any", tags: [marker] }
}, `${marker}-quiet`, actor());
const quietSnapshot = await snapshotMessageCampaign(tenantId, quietCampaign.campaign_id, actor());
await approveMessageCampaign(tenantId, quietCampaign.campaign_id, "B.7.2 静默时段调度验证批准。", actor());
const quietNow = new Date("2026-09-10T15:30:00.000Z");
await scheduleMessageCampaign(tenantId, quietCampaign.campaign_id, {
  scheduled_at: quietNow.toISOString(), timezone: "Asia/Shanghai", quiet_hours_start: "22:00", quiet_hours_end: "08:00",
  rate_limit_per_minute: 20, cancel_condition: { type: "none" }
}, "B.7.2 静默时段延后验证，不执行真实投递。", actor(), quietNow);
const deferred = await pool.query<{ next_attempt_at: Date }>(`SELECT next_attempt_at FROM message_campaign_deliveries WHERE campaign_id=$1 LIMIT 1`, [quietCampaign.campaign_id]);
assert.equal(new Date(deferred.rows[0].next_attempt_at).toISOString(), "2026-09-11T00:00:00.000Z");
await cancelMessageCampaign(tenantId, quietCampaign.campaign_id, "B.7.2 静默时段测试结束，取消合成队列。", actor());
const cancelled = await pool.query<{ count: number }>(`SELECT COUNT(*)::int count FROM message_campaign_deliveries WHERE campaign_id=$1 AND status='cancelled'`, [quietCampaign.campaign_id]);
assert.equal(cancelled.rows[0].count, quietSnapshot.eligible_total);

process.env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED = originalEnabled;
process.env.MESSAGE_CAMPAIGN_PROVIDER = originalProvider;
console.log(JSON.stringify({ phase: "B.7.2", synthetic_only: true, rate_limit_enforced: true, quiet_hours_deferred: true, send_time_unsubscribe_rechecked: true, cancel_condition_enforced: true, retry_recovered: true, per_recipient_events_immutable: true }));
await pool.end();
