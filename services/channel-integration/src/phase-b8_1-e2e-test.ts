import assert from "node:assert/strict";
import { pool } from "./database.js";
import { MockSocialProvider } from "./mock-social-provider.js";
import { ingestSocialEvent } from "./social-channel.js";
import { socialOverview } from "./social-channel-api.js";

const fixture = await pool.query<{ tenant_id: string }>(
  `SELECT tenant_id FROM tenants WHERE status IN ('active','test') ORDER BY created_at LIMIT 1`,
);
assert.ok(fixture.rows[0], "tenant fixture is required");
const tenantId = fixture.rows[0].tenant_id;
const marker = `b81-${Date.now()}`;
const mock = new MockSocialProvider();
await pool.query(
  `UPDATE channel_connections SET status='disabled',updated_at=NOW()
    WHERE tenant_id=$1 AND channel_type IN ('douyin','tiktok')
      AND configuration->>'mode'='synthetic' AND display_name LIKE 'B.8.1 %' AND status<>'disabled'`,
  [tenantId],
);

async function createConnection(provider: "douyin" | "tiktok") {
  const accountId = `${marker}-${provider}`;
  const capabilities = mock.capabilities(provider);
  const result = await pool.query<{ connection_id: string }>(
    `INSERT INTO channel_connections
      (tenant_id,channel_type,display_name,status,external_account_id,configuration,capability_snapshot,capability_checked_at)
     VALUES($1,$2,$3,'ready',$4,'{"mode":"synthetic"}'::jsonb,$5,NOW()) RETURNING connection_id`,
    [tenantId, provider, `B.8.1 ${provider}合成连接`, accountId, capabilities],
  );
  return { connection_id: result.rows[0].connection_id, account_id: accountId };
}

const douyin = await createConnection("douyin");
const tiktok = await createConnection("tiktok");
const occurredAt = new Date().toISOString();
const purchaseEvent = mock.event({
  provider: "tiktok",
  channel_connection_id: tiktok.connection_id,
  external_account_id: tiktok.account_id,
  event_type: "comment.created",
  content: "有货吗，我想购买十件",
  occurred_at: occurredAt,
});
const purchase = await ingestSocialEvent({
  tenant_id: tenantId,
  event: purchaseEvent,
  entitlements: ["social.comment_to_message"],
  user_authorized: true,
  reply_window_open: true,
});
assert.equal(purchase.classification.category, "purchase_intent");
assert.equal(purchase.route.route, "chatwoot_case");
assert.equal(purchase.comment_to_message.allowed, true);
assert.equal(purchase.comment_to_message.execution_mode, "human_confirmation");

const replay = await ingestSocialEvent({
  tenant_id: tenantId,
  event: purchaseEvent,
  entitlements: ["social.comment_to_message"],
  user_authorized: true,
  reply_window_open: true,
});
assert.equal(replay.duplicate, true);
assert.equal(replay.social_event_id, purchase.social_event_id);
await assert.rejects(
  () => ingestSocialEvent({ tenant_id: tenantId, event: { ...purchaseEvent, content: "不同事实" } }),
  /social_event_idempotency_conflict/,
);

const spam = await ingestSocialEvent({
  tenant_id: tenantId,
  event: mock.event({
    provider: "douyin",
    channel_connection_id: douyin.connection_id,
    external_account_id: douyin.account_id,
    event_type: "comment.created",
    content: "加微信 abcdef 加微信 ghijkl https://a.example https://b.example",
  }),
});
assert.equal(spam.route.route, "suppressed");

const complaint = await ingestSocialEvent({
  tenant_id: tenantId,
  event: mock.event({
    provider: "douyin",
    channel_connection_id: douyin.connection_id,
    external_account_id: douyin.account_id,
    event_type: "comment.created",
    content: "我要向市场监管投诉并举报",
  }),
});
assert.equal(complaint.route.route, "escalate");
assert.equal(complaint.route.priority, "high");

const dm = await ingestSocialEvent({
  tenant_id: tenantId,
  event: mock.event({
    provider: "tiktok",
    channel_connection_id: tiktok.connection_id,
    external_account_id: tiktok.account_id,
    event_type: "dm.message",
    content: "请问售后怎么处理？",
  }),
});
assert.equal(dm.route.route, "chatwoot_dm");

const persisted = await pool.query<{ event_count: number; classification_count: number; routing_count: number }>(
  `SELECT
    (SELECT COUNT(*)::int FROM social_events WHERE social_event_id=ANY($1::uuid[])) event_count,
    (SELECT COUNT(*)::int FROM social_classifications WHERE social_event_id=ANY($1::uuid[])) classification_count,
    (SELECT COUNT(*)::int FROM social_routing_decisions WHERE social_event_id=ANY($1::uuid[])) routing_count`,
  [[purchase.social_event_id, spam.social_event_id, complaint.social_event_id, dm.social_event_id]],
);
assert.deepEqual(persisted.rows[0], { event_count: 4, classification_count: 4, routing_count: 4 });
await assert.rejects(() => pool.query(`UPDATE social_classifications SET category='unknown' WHERE social_event_id=$1`, [purchase.social_event_id]));
await assert.rejects(() => pool.query(`DELETE FROM social_routing_decisions WHERE social_event_id=$1`, [purchase.social_event_id]));

const chatwootWrites = await pool.query<{ count: number }>(
  `SELECT COUNT(*)::int count FROM gateway_events WHERE external_event_id LIKE $1`,
  [`mock-event-%`],
);
assert.equal(chatwootWrites.rows[0].count, 0, "foundation ingestion must not write to Chatwoot delivery queue");
await pool.query(`UPDATE channel_connections SET status='disabled',updated_at=NOW() WHERE connection_id=ANY($1::uuid[])`, [[douyin.connection_id, tiktok.connection_id]]);
const overview = await socialOverview(tenantId);
assert.ok(overview.metrics.total >= 4);
assert.ok(overview.queue.some((item: { social_event_id: string }) => item.social_event_id === purchase.social_event_id));
assert.ok(overview.queue.some((item: { social_event_id: string }) => item.social_event_id === complaint.social_event_id));
assert.ok(!JSON.stringify(overview).includes(`${marker}-tiktok`), "overview must not expose external account ids from disabled fixtures");

console.log(JSON.stringify({
  phase: "B.8.1",
  normalized_events: true,
  idempotency_conflict_rejected: true,
  spam_suppressed: true,
  complaint_escalated: true,
  dm_routed: true,
  comment_to_message_human_gate: true,
  immutable_decisions: true,
  real_network_calls: mock.networkCalls,
  chatwoot_writes: 0,
  tenant_overview: true,
}));
await pool.end();
