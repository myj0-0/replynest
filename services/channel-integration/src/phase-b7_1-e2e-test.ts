import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { approveMessageCampaign, createMessageCampaign, listMessageCampaigns, recordMarketingConsent, snapshotMessageCampaign } from "./message-campaigns.js";

const fixture = await pool.query<{ tenant_id: string; platform_user_id: string }>(
  `SELECT m.tenant_id,m.platform_user_id FROM tenant_memberships m JOIN tenants t ON t.tenant_id=m.tenant_id
    WHERE m.role='tenant_admin' AND m.status='active' AND t.status IN ('active','test') ORDER BY t.created_at LIMIT 1`
);
assert.ok(fixture.rows[0], "tenant admin fixture is required");
const { tenant_id: tenantId, platform_user_id: userId } = fixture.rows[0];
const marker = `b71-${Date.now()}`;
const conversationBase = Date.now();
const actor = () => ({ actor_type: "console_session" as const, actor_id: userId, request_id: randomUUID() });

const identities: string[] = [];
for (let index = 0; index < 3; index += 1) {
  const customer = await pool.query<{ customer_id: string }>(
    `INSERT INTO customers(tenant_id,name,attributes) VALUES($1,$2,$3) RETURNING customer_id`,
    [tenantId, `B.7.1 合成客户 ${index + 1}`, JSON.stringify({ tags: [marker] })]
  );
  const identity = await pool.query<{ identity_id: string }>(
    `INSERT INTO channel_identities(tenant_id,customer_id,channel,external_user_id,chatwoot_source_id,chatwoot_conversation_id)
     VALUES($1,$2,'mock-wechat',$3,$4,$5) RETURNING identity_id`,
    [tenantId, customer.rows[0].customer_id, `${marker}-user-${index}`, `${marker}-source-${index}`, conversationBase + index]
  );
  identities.push(identity.rows[0].identity_id);
}

await recordMarketingConsent(tenantId, identities[0], { status: "granted", source: "customer_action", evidence_ref: `${marker}:opt-in` }, `${marker}-consent-0`, actor());
await recordMarketingConsent(tenantId, identities[1], { status: "granted", source: "customer_action", evidence_ref: `${marker}:opt-in` }, `${marker}-consent-1a`, actor());
await recordMarketingConsent(tenantId, identities[1], { status: "withdrawn", source: "customer_action", evidence_ref: `${marker}:unsubscribe` }, `${marker}-consent-1b`, actor());

const input = { name: `B.7.1 合成活动 ${marker}`, content: "这是一条不会真实发送的合成营销消息。", channel: "mock-wechat", audience_filter: { mode: "tags_any", tags: [marker] } };
const campaign = await createMessageCampaign(tenantId, input, `${marker}-campaign`, actor());
const replay = await createMessageCampaign(tenantId, input, `${marker}-campaign`, actor());
assert.equal(replay.campaign_id, campaign.campaign_id);
await assert.rejects(() => createMessageCampaign(tenantId, { ...input, content: "不同事实" }, `${marker}-campaign`, actor()), (error: any) => error.code === "idempotency_key_conflict");

const snapshotted = await snapshotMessageCampaign(tenantId, campaign.campaign_id, actor());
assert.equal(snapshotted.audience_total, 3);
assert.equal(snapshotted.eligible_total, 1);
assert.equal(snapshotted.suppressed_total, 2);
const reasons = await pool.query<{ suppression_reason: string; count: string }>(
  `SELECT suppression_reason,COUNT(*)::text count FROM message_campaign_recipients WHERE campaign_id=$1 AND NOT eligible GROUP BY suppression_reason`, [campaign.campaign_id]
);
assert.deepEqual(Object.fromEntries(reasons.rows.map(row => [row.suppression_reason, Number(row.count)])), { consent_missing: 1, unsubscribed: 1 });

await recordMarketingConsent(tenantId, identities[2], { status: "granted", source: "customer_action", evidence_ref: `${marker}:late-opt-in` }, `${marker}-consent-2`, actor());
const frozen = await snapshotMessageCampaign(tenantId, campaign.campaign_id, actor());
assert.equal(frozen.eligible_total, 1, "late consent cannot rewrite the frozen audience");
const approved = await approveMessageCampaign(tenantId, campaign.campaign_id, "B.7.1 合成验收：仅批准快照，不允许真实发送。", actor());
assert.equal(approved.status, "approved");

await assert.rejects(() => pool.query(`DELETE FROM message_campaign_recipients WHERE campaign_id=$1`, [campaign.campaign_id]));
await assert.rejects(() => pool.query(`UPDATE marketing_consent_events SET status='granted' WHERE tenant_id=$1 AND identity_id=$2`, [tenantId, identities[1]]));
await assert.rejects(() => pool.query(`UPDATE message_campaigns SET content='tampered' WHERE campaign_id=$1`, [campaign.campaign_id]));
await assert.rejects(() => pool.query(`DELETE FROM message_campaign_events WHERE campaign_id=$1`, [campaign.campaign_id]));
const otherTenant = await pool.query<{ tenant_id: string }>(`SELECT tenant_id FROM tenants WHERE tenant_id<>$1 ORDER BY created_at LIMIT 1`, [tenantId]);
if (otherTenant.rows[0]) await assert.rejects(() => snapshotMessageCampaign(otherTenant.rows[0].tenant_id, campaign.campaign_id, actor()), (error: any) => error.code === "campaign_not_found");
const audits = await pool.query(`SELECT COUNT(*)::int count FROM audit_logs WHERE tenant_id=$1 AND resource_type='message_campaign' AND resource_id=$2`, [tenantId, campaign.campaign_id]);
assert.equal(audits.rows[0].count, 3);
const delivered = await pool.query(`SELECT COUNT(*)::int count FROM outbound_deliveries WHERE tenant_id=$1 AND payload->>'campaign_id'=$2`, [tenantId, campaign.campaign_id]);
assert.equal(delivered.rows[0].count, 0);
const overview = await listMessageCampaigns(tenantId);
assert.equal(overview.execution_enabled, false);
assert.ok(overview.data.some((item: any) => item.campaign_id === campaign.campaign_id));

console.log(JSON.stringify({ phase: "B.7.1", explicit_consent_required: true, unsubscribe_suppressed: true, audience_snapshot_immutable: true, campaign_facts_immutable: true, cross_tenant_hidden: true, idempotent_draft: true, approval_audited: true, real_delivery_created: false }));
await pool.end();
