import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { MockSocialProvider } from "./mock-social-provider.js";
import { ingestSocialEvent } from "./social-channel.js";
import { socialOverview } from "./social-channel-api.js";
import {
  correctSocialClassification,
  createSocialRule,
  recordSocialCaseAction,
  updateSocialRule,
} from "./social-moderation.js";

const fixture = await pool.query<{ tenant_id: string; platform_user_id: string }>(
  `SELECT t.tenant_id,m.platform_user_id
     FROM tenants t JOIN tenant_memberships m ON m.tenant_id=t.tenant_id
    WHERE t.status IN ('active','test') AND m.status='active' AND m.role='tenant_admin'
    ORDER BY t.created_at LIMIT 1`,
);
assert.ok(fixture.rows[0], "tenant admin fixture is required");
const { tenant_id: tenantId, platform_user_id: platformUserId } = fixture.rows[0];
const marker = `b811-${Date.now()}`;
const actor = { actor_type: "console_session", actor_id: platformUserId, platform_user_id: platformUserId };
const mock = new MockSocialProvider();

const rule = await createSocialRule({
  tenant_id: tenantId,
  actor,
  request_id: randomUUID(),
  body: {
    name: `B.8.1.1 临时退款 ${marker}`,
    priority: 900,
    category: "after_sales",
    keywords: [marker, "临时退款批次"],
    status: "active",
  },
});
assert.equal(rule.version, 1);

const accountId = `${marker}-douyin`;
const connection = await pool.query<{ connection_id: string }>(
  `INSERT INTO channel_connections
    (tenant_id,channel_type,display_name,status,external_account_id,configuration,capability_snapshot,capability_checked_at)
   VALUES($1,'douyin','B.8.1.1 合成连接','ready',$2,'{"mode":"synthetic"}'::jsonb,$3,NOW()) RETURNING connection_id`,
  [tenantId, accountId, mock.capabilities("douyin")],
);
const ingested = await ingestSocialEvent({
  tenant_id: tenantId,
  event: mock.event({
    provider: "douyin",
    channel_connection_id: connection.rows[0].connection_id,
    external_account_id: accountId,
    event_type: "comment.created",
    content: `${marker} 这批商品要怎么处理`,
  }),
  notification_delivery_mode: "in_app_only",
});
assert.equal(ingested.classification.source, "tenant_rule");
assert.equal(ingested.classification.category, "after_sales");
assert.equal(ingested.notification_error, false);

const correction = await correctSocialClassification({
  tenant_id: tenantId,
  social_event_id: ingested.social_event_id,
  category: "complaint_risk",
  reason: "人工核对上下文后确认客户明确提出监管投诉",
  actor,
  request_id: randomUUID(),
  notification_delivery_mode: "in_app_only",
});
assert.equal(correction.previous_category, "after_sales");
assert.equal(correction.corrected_category, "complaint_risk");
assert.equal(correction.corrected_route, "escalate");

const acknowledged = await recordSocialCaseAction({
  tenant_id: tenantId,
  social_event_id: ingested.social_event_id,
  action: "acknowledge",
  reason: "主管已经认领并开始联系对应业务负责人",
  actor,
  request_id: randomUUID(),
  notification_delivery_mode: "in_app_only",
});
assert.equal(acknowledged.resulting_state, "acknowledged");
const resolved = await recordSocialCaseAction({
  tenant_id: tenantId,
  social_event_id: ingested.social_event_id,
  action: "resolve",
  reason: "业务负责人已完成核查并向客户提供处理方案",
  actor,
  request_id: randomUUID(),
  notification_delivery_mode: "in_app_only",
});
assert.equal(resolved.resulting_state, "resolved");

await assert.rejects(() => updateSocialRule({
  tenant_id: tenantId,
  rule_id: rule.rule_id,
  expected_version: 99,
  actor,
  request_id: randomUUID(),
  body: { ...rule, status: "disabled" },
}), /social_rule_version_conflict/);
const disabled = await updateSocialRule({
  tenant_id: tenantId,
  rule_id: rule.rule_id,
  expected_version: 1,
  actor,
  request_id: randomUUID(),
  body: { ...rule, status: "disabled" },
});
assert.equal(disabled.status, "disabled");
assert.equal(disabled.version, 2);

await assert.rejects(() => pool.query(`UPDATE social_classification_corrections SET corrected_category='spam' WHERE correction_id=$1`, [correction.correction_id]));
await assert.rejects(() => pool.query(`DELETE FROM social_case_actions WHERE social_event_id=$1`, [ingested.social_event_id]));
const notification = await pool.query(
  `SELECT status,occurrence_count FROM notification_events
    WHERE tenant_id=$1 AND resource_type='social_event' AND resource_id=$2 ORDER BY created_at DESC LIMIT 1`,
  [tenantId, ingested.social_event_id],
);
assert.equal(notification.rows[0]?.status, "resolved");
assert.ok(Number(notification.rows[0]?.occurrence_count) >= 1);
const audits = await pool.query<{ count: number }>(
  `SELECT COUNT(*)::int count FROM audit_logs WHERE tenant_id=$1 AND resource_id IN ($2,$3)
    AND action IN ('social.rule_created','social.rule_updated','social.classification_corrected','social.case_acknowledge','social.case_resolve')`,
  [tenantId, rule.rule_id, ingested.social_event_id],
);
assert.equal(audits.rows[0].count, 5);
const overview = await socialOverview(tenantId);
assert.ok(!overview.queue.some((item: { social_event_id: string }) => item.social_event_id === ingested.social_event_id));
await pool.query(`UPDATE channel_connections SET status='disabled',updated_at=NOW() WHERE connection_id=$1`, [connection.rows[0].connection_id]);

console.log(JSON.stringify({
  phase: "B.8.1.1",
  tenant_rules_applied: true,
  optimistic_rule_versioning: true,
  human_correction_append_only: true,
  case_action_append_only: true,
  notification_resolved_with_case: true,
  audit_actions: 5,
  resolved_removed_from_queue: true,
  real_network_calls: mock.networkCalls,
  chatwoot_writes: 0,
}));
await pool.end();
