import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { MockSocialProvider } from "./mock-social-provider.js";
import { ingestSocialEvent } from "./social-channel.js";
import { socialQualityReport } from "./social-channel-api.js";
import { confirmSocialClassification, correctSocialClassification } from "./social-moderation.js";

const fixture = await pool.query<{ tenant_id: string; platform_user_id: string }>(
  `SELECT t.tenant_id,m.platform_user_id FROM tenants t JOIN tenant_memberships m ON m.tenant_id=t.tenant_id
    WHERE t.status IN ('active','test') AND m.status='active' AND m.role='tenant_admin' ORDER BY t.created_at LIMIT 1`,
);
assert.ok(fixture.rows[0], "tenant admin fixture is required");
const { tenant_id: tenantId, platform_user_id: platformUserId } = fixture.rows[0];
const actor = { actor_type: "console_session", actor_id: platformUserId, platform_user_id: platformUserId };
const marker = `b812-${Date.now()}`;
const mock = new MockSocialProvider();
const baseline = await socialQualityReport(tenantId, 30);
const connection = await pool.query<{ connection_id: string }>(
  `INSERT INTO channel_connections
    (tenant_id,channel_type,display_name,status,external_account_id,configuration,capability_snapshot,capability_checked_at)
   VALUES($1,'tiktok','B.8.1.2 质量评测','ready',$2,'{"mode":"synthetic"}'::jsonb,$3,NOW()) RETURNING connection_id`,
  [tenantId, `${marker}-account`, mock.capabilities("tiktok")],
);

const first = await ingestSocialEvent({
  tenant_id: tenantId,
  event: mock.event({ provider: "tiktok", channel_connection_id: connection.rows[0].connection_id,
    external_account_id: `${marker}-account`, event_type: "comment.created", content: `${marker} 怎么买，有货吗` }),
  notification_delivery_mode: "in_app_only",
});
await confirmSocialClassification({ tenant_id: tenantId, social_event_id: first.social_event_id,
  reason: "人工核对评论上下文后确认属于明确购买意向", actor, request_id: randomUUID() });

const second = await ingestSocialEvent({
  tenant_id: tenantId,
  event: mock.event({ provider: "tiktok", channel_connection_id: connection.rows[0].connection_id,
    external_account_id: `${marker}-account`, event_type: "comment.created", content: `${marker} 我要投诉这个订单` }),
  notification_delivery_mode: "in_app_only",
});
await correctSocialClassification({ tenant_id: tenantId, social_event_id: second.social_event_id, category: "after_sales",
  reason: "人工核对后确认客户当前仅要求订单售后处理", actor, request_id: randomUUID(), notification_delivery_mode: "in_app_only" });

const report = await socialQualityReport(tenantId, "30");
assert.equal(Number(report.totals.classified), Number(baseline.totals.classified) + 2);
assert.equal(Number(report.totals.reviewed), Number(baseline.totals.reviewed) + 2);
assert.equal(Number(report.totals.confirmed), Number(baseline.totals.confirmed) + 1);
assert.equal(Number(report.totals.corrected), Number(baseline.totals.corrected) + 1);
assert.ok(report.confusions.some(row => row.machine_category === "complaint_risk" && row.evaluated_category === "after_sales"));
await assert.rejects(() => pool.query(`DELETE FROM social_classification_evaluations WHERE social_event_id=$1`, [first.social_event_id]));
await pool.query(`UPDATE channel_connections SET status='disabled',updated_at=NOW() WHERE connection_id=$1`, [connection.rows[0].connection_id]);

console.log(JSON.stringify({ phase: "B.8.1.2", reviewed_delta: 2, confirmed_delta: 1, corrected_delta: 1,
  accuracy_denominator: "human_reviewed_only", append_only_evaluations: true, real_network_calls: mock.networkCalls, chatwoot_writes: 0 }));
await pool.end();
