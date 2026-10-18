import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { LedgerConflictError, LedgerNotFoundError, ledgerBalances, postLedgerTransaction, reverseLedgerTransaction } from "./ledger.js";
import { requiredEnv } from "./shared.js";

const tenantId = requiredEnv("ISOLATION_TEST_TENANT_ID");
const otherTenantId = requiredEnv("DEMO_TENANT_ID");
const marker = randomUUID();
const actor = () => ({ actor_id: "phase-b1-e2e", request_id: randomUUID() });
const dangling = await pool.query<{ transaction_id: string }>(
  `SELECT t.transaction_id FROM ledger_transactions t
    WHERE t.tenant_id=$1 AND t.source_type='synthetic_phase_b1' AND t.transaction_type<>'reversal' AND t.status='posted'
      AND NOT EXISTS(SELECT 1 FROM ledger_transactions r WHERE r.reversal_of=t.transaction_id)`, [tenantId]
);
for (const item of dangling.rows) await reverseLedgerTransaction(tenantId, item.transaction_id, `phase-b1-recovery-${item.transaction_id}`, "recover interrupted synthetic test", actor());
const before = await ledgerBalances(tenantId);
const beforeGift = BigInt(before.accounts.find(item => item.account === "gift")!.balance_minor);
const grantInput = (key: string, source: string, amount = 5000) => ({
  transaction_type: "gift_grant", currency: "CNY", idempotency_key: key,
  source_type: "synthetic_phase_b1", source_id: source, occurred_at: new Date().toISOString(),
  metadata: { synthetic: true, marker }, entries: [
    { account: "clearing", direction: "debit", amount_minor: amount },
    { account: "gift", direction: "credit", amount_minor: amount, expires_at: new Date(Date.now() + 14 * 86400_000).toISOString() },
  ],
});

const firstKey = `phase-b1-${marker}-grant`;
const firstInput = grantInput(firstKey, `grant-${marker}`);
const first = await postLedgerTransaction(tenantId, firstInput, actor());
assert.equal(first.idempotent_replay, false);
const replay = await postLedgerTransaction(tenantId, firstInput, actor());
assert.equal(replay.transaction_id, first.transaction_id);
assert.equal(replay.idempotent_replay, true);
await assert.rejects(() => postLedgerTransaction(tenantId, { ...firstInput, entries: firstInput.entries.map(entry => ({ ...entry, amount_minor: 5100 })) }, actor()), LedgerConflictError);

const concurrentKey = `phase-b1-${marker}-concurrent`;
const concurrentInput = grantInput(concurrentKey, `concurrent-${marker}`, 7000);
const concurrent = await Promise.all(Array.from({ length: 12 }, () => postLedgerTransaction(tenantId, concurrentInput, actor())));
assert.equal(new Set(concurrent.map(item => item.transaction_id)).size, 1);
assert.equal(concurrent.filter(item => !item.idempotent_replay).length, 1);

const afterGrants = await ledgerBalances(tenantId);
assert.equal(BigInt(afterGrants.accounts.find(item => item.account === "gift")!.balance_minor), beforeGift + 12000n);

await assert.rejects(() => reverseLedgerTransaction(otherTenantId, first.transaction_id, `phase-b1-${marker}-cross`, "cross tenant test", actor()), LedgerNotFoundError);
const firstReversal = await reverseLedgerTransaction(tenantId, first.transaction_id, `phase-b1-${marker}-reverse-1`, "synthetic cleanup", actor());
assert.equal(firstReversal.idempotent_replay, false);
const reversalReplay = await reverseLedgerTransaction(tenantId, first.transaction_id, `phase-b1-${marker}-reverse-1`, "synthetic cleanup", actor());
assert.equal(reversalReplay.transaction_id, firstReversal.transaction_id);
assert.equal(reversalReplay.idempotent_replay, true);
await assert.rejects(() => reverseLedgerTransaction(tenantId, first.transaction_id, `phase-b1-${marker}-reverse-duplicate`, "duplicate reversal test", actor()), LedgerConflictError);
await reverseLedgerTransaction(tenantId, concurrent[0].transaction_id, `phase-b1-${marker}-reverse-2`, "synthetic cleanup", actor());

const finalBalances = await ledgerBalances(tenantId);
assert.equal(BigInt(finalBalances.accounts.find(item => item.account === "gift")!.balance_minor), beforeGift);

await assert.rejects(() => pool.query(`UPDATE ledger_entries SET amount_minor=amount_minor+1 WHERE transaction_id=$1`, [first.transaction_id]), /append-only|immutable/);
await assert.rejects(() => pool.query(`DELETE FROM ledger_transactions WHERE transaction_id=$1`, [first.transaction_id]), /append-only|immutable/);
await assert.rejects(() => pool.query(
  `INSERT INTO ledger_transactions(tenant_id,currency,transaction_type,status,idempotency_key,request_hash,source_type,source_id,metadata,occurred_at,posted_at,created_by)
   VALUES($1,'CNY','adjustment','posted',$2,repeat('b',64),'synthetic_phase_b1',$3,'{}'::jsonb,NOW(),NOW(),'phase-b1-e2e')`,
  [tenantId, `phase-b1-${marker}-direct-posted`, `direct-posted-${marker}`]
), /must start pending/);

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const pending = await client.query<{ transaction_id: string }>(
    `INSERT INTO ledger_transactions(tenant_id,currency,transaction_type,idempotency_key,request_hash,source_type,source_id,metadata,occurred_at,created_by)
     VALUES($1,'CNY','adjustment',$2,repeat('a',64),'synthetic_phase_b1',$3,'{}'::jsonb,NOW(),'phase-b1-e2e') RETURNING transaction_id`,
    [tenantId, `phase-b1-${marker}-unbalanced`, `unbalanced-${marker}`]
  );
  await client.query(`INSERT INTO ledger_entries(transaction_id,tenant_id,account,direction,amount_minor,currency) VALUES($1,$2,'gift','credit',100,'CNY')`, [pending.rows[0].transaction_id, tenantId]);
  await assert.rejects(() => client.query(`UPDATE ledger_transactions SET status='posted',posted_at=NOW() WHERE transaction_id=$1`, [pending.rows[0].transaction_id]), /not balanced/);
  await client.query("ROLLBACK");
} finally { client.release(); }

const posted = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ledger_transactions WHERE tenant_id=$1 AND metadata->>'marker'=$2 AND status='posted'`, [tenantId, marker]);
assert.equal(posted.rows[0].count, "2");
const reversals = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ledger_transactions WHERE tenant_id=$1 AND reversal_of=ANY($2::uuid[]) AND status='posted'`, [tenantId, [first.transaction_id, concurrent[0].transaction_id]]);
assert.equal(reversals.rows[0].count, "2");
console.log(`phase_b1_e2e=ok marker=${marker} posted=4 idempotent=true concurrent=12 append_only=true balanced=true cross_tenant=true net_balance_unchanged=true`);
await pool.end();
