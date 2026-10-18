import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { requiredEnv } from "./shared.js";

const mockBase = requiredEnv("MOCK_WECHAT_BASE_URL").replace(/\/$/, "");
const gatewayBase = process.env.PHASE5_GATEWAY_URL ?? "http://127.0.0.1:3001";
const tenantId = requiredEnv("DEMO_TENANT_ID");
const apiKey = requiredEnv("DEMO_TENANT_API_KEY");
const runId = randomUUID().replaceAll("-", "");
const eventPrefix = `phase522-${runId}-e`;
const messagePrefix = `phase522-${runId}-m`;

async function simulate(index: number) {
  const started = Date.now();
  const response = await fetch(`${mockBase}/simulate/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event_id: `${eventPrefix}${index}`,
      message_id: `${messagePrefix}${index}`,
      user_id: "wx-demo-user",
      user_name: "Phase 5.2.2 合成用户",
      text: `Phase 5.2.2 合成消息 ${index}`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 202);
  const body = await response.json() as any;
  return { duplicate: Boolean(body.gateway?.duplicate), latency: Date.now() - started };
}

async function waitFor(query: () => Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await query()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("phase5_2_2_wait_timeout");
}

try {
  const duplicateBurst = await Promise.all(Array.from({ length: 20 }, () => simulate(0)));
  const remaining = await Promise.all(Array.from({ length: 99 }, (_, index) => simulate(index + 1)));
  const submissions = [...duplicateBurst, ...remaining];
  assert.equal(duplicateBurst.filter(item => !item.duplicate).length, 1);
  assert.equal(duplicateBurst.filter(item => item.duplicate).length, 19);
  assert.ok(Math.max(...submissions.map(item => item.latency)) < 5_000);

  await waitFor(async () => {
    const states = await pool.query<{ status: string; count: string }>(
      `SELECT status,COUNT(*)::text AS count FROM gateway_events
        WHERE tenant_id=$1 AND external_event_id LIKE $2 GROUP BY status`,
      [tenantId, `${eventPrefix}%`]
    );
    return states.rows.length === 1 && states.rows[0].status === "processed" && Number(states.rows[0].count) === 100;
  });
  const processed = await pool.query<{ events: string; messages: string; outbox: string }>(
    `SELECT COUNT(*)::text AS events,COUNT(DISTINCT chatwoot_message_id)::text AS messages,
       (SELECT COUNT(*)::text FROM outbox_events WHERE aggregate_id LIKE $2) AS outbox
       FROM gateway_events WHERE tenant_id=$1 AND external_event_id LIKE $3 AND status='processed'`,
    [tenantId, `${messagePrefix}%`, `${eventPrefix}%`]
  );
  assert.deepEqual(processed.rows[0], { events: "100", messages: "100", outbox: "100" });

  const deadEvent = `${eventPrefix}-dead`;
  const deadMessage = `${messagePrefix}-dead`;
  const insertedDead = await pool.query<{ id: string }>(
    `INSERT INTO gateway_events
      (tenant_id,channel,external_event_id,external_message_id,status,payload,next_attempt_at,updated_at)
     VALUES ($1,'mock-wechat',$2,$3,'queued','{"normalized":{}}'::jsonb,NOW(),NOW()) RETURNING id`,
    [tenantId, deadEvent, deadMessage]
  );
  await waitFor(async () => (await pool.query(`SELECT 1 FROM gateway_events WHERE id=$1 AND status='dead'`, [insertedDead.rows[0].id])).rowCount === 1);

  const list = await fetch(`${gatewayBase}/api/v1/inbound-events?status=dead&limit=100`, {
    headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(list.status, 200);
  const listed = await list.json() as any;
  assert.ok(listed.data.some((row: any) => String(row.id) === insertedDead.rows[0].id));
  assert.equal(JSON.stringify(listed).includes("normalized"), false);

  const replay = await fetch(`${gatewayBase}/api/v1/inbound-events/${insertedDead.rows[0].id}/replay`, {
    method: "POST", headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(replay.status, 202);
  await waitFor(async () => (await pool.query(
    `SELECT 1 FROM gateway_events WHERE id=$1 AND status='dead' AND replay_count=1`, [insertedDead.rows[0].id]
  )).rowCount === 1);

  console.log("Phase 5.2.2 E2E passed: 100 unique messages, 20-way duplicate burst, queue processing, DLQ and audited replay");
} finally {
  await pool.query(`DELETE FROM outbox_events WHERE aggregate_id LIKE $1`, [`${messagePrefix}%`]);
  await pool.query(`DELETE FROM gateway_events WHERE tenant_id=$1 AND external_event_id LIKE $2`, [tenantId, `${eventPrefix}%`]);
  await pool.end();
}
