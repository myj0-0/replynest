import type { PoolClient } from "pg";
import { pool } from "./database.js";
import { ledgerRequestHash, reverseLedgerEntries, tenantBalanceAccounts, validateLedgerInput, type LedgerEntryInput, type LedgerTransactionInput } from "./ledger-core.js";

export class LedgerConflictError extends Error {}
export class LedgerNotFoundError extends Error {}

export type LedgerActor = { actor_id: string; request_id: string };

async function transactionView(client: PoolClient, tenantId: string, transactionId: string) {
  const result = await client.query(
    `SELECT t.transaction_id,t.transaction_type,t.status,t.currency,t.idempotency_key,t.source_type,t.source_id,
            t.reversal_of,t.metadata,t.occurred_at,t.posted_at,t.created_at,
            COALESCE(jsonb_agg(jsonb_build_object('entry_id',e.entry_id,'account',e.account,'direction',e.direction,
              'amount_minor',e.amount_minor::text,'currency',e.currency,'expires_at',e.expires_at)
              ORDER BY e.created_at,e.entry_id) FILTER (WHERE e.entry_id IS NOT NULL),'[]'::jsonb) AS entries
       FROM ledger_transactions t LEFT JOIN ledger_entries e ON e.transaction_id=t.transaction_id
      WHERE t.tenant_id=$1 AND t.transaction_id=$2 GROUP BY t.transaction_id`,
    [tenantId, transactionId]
  );
  return result.rows[0];
}

async function insertPending(client: PoolClient, tenantId: string, input: LedgerTransactionInput, requestHash: string, actorId: string, reversalOf: string | null) {
  await client.query(`INSERT INTO billing_accounts(tenant_id,currency) VALUES($1,$2) ON CONFLICT(tenant_id,currency) DO NOTHING`, [tenantId, input.currency]);
  const inserted = await client.query<{ transaction_id: string }>(
    `INSERT INTO ledger_transactions(tenant_id,currency,transaction_type,idempotency_key,request_hash,source_type,source_id,reversal_of,metadata,occurred_at,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
     ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING transaction_id`,
    [tenantId, input.currency, input.transaction_type, input.idempotency_key, requestHash, input.source_type, input.source_id, reversalOf, JSON.stringify(input.metadata ?? {}), input.occurred_at, actorId]
  );
  if (inserted.rows[0]) return { transaction_id: inserted.rows[0].transaction_id, existing: false };
  const existing = await client.query<{ transaction_id: string; request_hash: string; status: string }>(
    `SELECT transaction_id,request_hash,status FROM ledger_transactions WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE`, [tenantId, input.idempotency_key]
  );
  if (!existing.rows[0] || existing.rows[0].request_hash !== requestHash) throw new LedgerConflictError("idempotency key already represents different ledger facts");
  if (existing.rows[0].status !== "posted") throw new LedgerConflictError("idempotent ledger transaction is incomplete");
  return { transaction_id: existing.rows[0].transaction_id, existing: true };
}

async function insertEntriesAndPost(client: PoolClient, tenantId: string, transactionId: string, currency: string, entries: LedgerEntryInput[]) {
  for (const entry of entries) {
    await client.query(
      `INSERT INTO ledger_entries(transaction_id,tenant_id,account,direction,amount_minor,currency,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [transactionId, tenantId, entry.account, entry.direction, entry.amount_minor, currency, entry.expires_at ?? null]
    );
  }
  await client.query(`UPDATE ledger_transactions SET status='posted',posted_at=clock_timestamp() WHERE transaction_id=$1 AND tenant_id=$2 AND status='pending'`, [transactionId, tenantId]);
}

export async function postLedgerTransaction(tenantId: string, raw: unknown, actor: LedgerActor) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const view = await postLedgerInTransaction(client,tenantId,raw,actor);
    await client.query("COMMIT");
    return view;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

/** Caller owns BEGIN/COMMIT. Shared lock serializes wallet spending and all ledger writers. */
export async function postLedgerInTransaction(client:PoolClient,tenantId:string,raw:unknown,actor:LedgerActor) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`wallet:${tenantId}`]);
    const input=validateLedgerInput(raw),requestHash=ledgerRequestHash(input);
    const pending = await insertPending(client, tenantId, input, requestHash, actor.actor_id, null);
    if (!pending.existing) {
      await insertEntriesAndPost(client, tenantId, pending.transaction_id, input.currency, input.entries);
      await client.query(
        `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
         VALUES($1,'internal_service',$2,'ledger.transaction_posted','ledger_transaction',$3,jsonb_build_object('transaction_type',$4::text,'currency',$5::text,'source_type',$6::text),$7)`,
        [tenantId, actor.actor_id, pending.transaction_id, input.transaction_type, input.currency, input.source_type, actor.request_id]
      );
    }
    const view = await transactionView(client, tenantId, pending.transaction_id);
    return { ...view, idempotent_replay: pending.existing };
}

export async function reverseLedgerTransaction(tenantId: string, originalId: string, idempotencyKey: string, reason: string, actor: LedgerActor) {
  if (!/^[0-9a-f-]{36}$/i.test(originalId)) throw new LedgerNotFoundError("ledger transaction not found");
  if (!idempotencyKey.trim() || idempotencyKey.length > 128) throw new Error("invalid ledger idempotency key");
  if (!reason.trim() || reason.length > 500) throw new Error("reversal reason is required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`wallet:${tenantId}`]);
    const original = await client.query<{ transaction_id: string; currency: string; source_type: string; source_id: string; occurred_at: Date; status: string }>(
      `SELECT transaction_id,currency,source_type,source_id,occurred_at,status FROM ledger_transactions WHERE tenant_id=$1 AND transaction_id=$2 FOR UPDATE`, [tenantId, originalId]
    );
    if (!original.rows[0] || original.rows[0].status !== "posted") throw new LedgerNotFoundError("ledger transaction not found");
    const replay = await client.query<{ transaction_id: string; reversal_of: string | null; status: string }>(
      `SELECT transaction_id,reversal_of,status FROM ledger_transactions WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE`, [tenantId, idempotencyKey.trim()]
    );
    if (replay.rows[0]) {
      if (replay.rows[0].reversal_of !== originalId || replay.rows[0].status !== "posted") throw new LedgerConflictError("idempotency key already represents different ledger facts");
      const view = await transactionView(client, tenantId, replay.rows[0].transaction_id);
      await client.query("COMMIT");
      return { ...view, idempotent_replay: true };
    }
    const originalEntries = await client.query<{ account: LedgerEntryInput["account"]; direction: LedgerEntryInput["direction"]; amount_minor: string }>(
      `SELECT account,direction,amount_minor::text FROM ledger_entries WHERE transaction_id=$1 ORDER BY created_at,entry_id`, [originalId]
    );
    const input: LedgerTransactionInput = {
      transaction_type: "reversal", currency: original.rows[0].currency, idempotency_key: idempotencyKey.trim(),
      source_type: "ledger_reversal", source_id: originalId, occurred_at: new Date().toISOString(),
      metadata: { reason: reason.trim(), original_source_type: original.rows[0].source_type, original_source_id: original.rows[0].source_id },
      entries: reverseLedgerEntries(originalEntries.rows.map(entry => ({ ...entry, amount_minor: Number(entry.amount_minor), expires_at: null }))),
    };
    const requestHash = ledgerRequestHash(input);
    const pending = await insertPending(client, tenantId, input, requestHash, actor.actor_id, originalId);
    if (!pending.existing) {
      await insertEntriesAndPost(client, tenantId, pending.transaction_id, input.currency, input.entries);
      await client.query(
        `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,reason,after_data,request_id)
         VALUES($1,'internal_service',$2,'ledger.transaction_reversed','ledger_transaction',$3,$4,jsonb_build_object('reversal_of',$5::text),$6)`,
        [tenantId, actor.actor_id, pending.transaction_id, reason.trim(), originalId, actor.request_id]
      );
    }
    const view = await transactionView(client, tenantId, pending.transaction_id);
    await client.query("COMMIT");
    return { ...view, idempotent_replay: pending.existing };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof Error && /ledger_transactions_single_reversal_idx/.test(error.message)) throw new LedgerConflictError("ledger transaction was already reversed");
    throw error;
  } finally { client.release(); }
}

export async function ledgerBalances(tenantId: string, currency = "CNY") {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("invalid ledger currency");
  const result = await pool.query<{ account: string; balance_minor: string }>(
    `SELECT e.account,(SUM(CASE WHEN e.direction='credit' THEN e.amount_minor ELSE -e.amount_minor END))::text AS balance_minor
       FROM ledger_entries e JOIN ledger_transactions t ON t.transaction_id=e.transaction_id
      WHERE e.tenant_id=$1 AND e.currency=$2 AND t.status='posted' AND e.account=ANY($3::text[])
      GROUP BY e.account`, [tenantId, currency, [...tenantBalanceAccounts]]
  );
  const values = new Map(result.rows.map(row => [row.account, row.balance_minor]));
  return { currency, accounts: tenantBalanceAccounts.map(account => ({ account, balance_minor: values.get(account) ?? "0" })), projection: "credit_minus_debit", generated_at: new Date().toISOString() };
}

export async function listLedgerTransactions(tenantId: string, limit: number, offset = 0) {
  const result = await pool.query(
    `SELECT t.transaction_id,t.transaction_type,t.status,t.currency,t.source_type,t.source_id,t.reversal_of,t.metadata,t.occurred_at,t.posted_at,t.created_at,
            COALESCE(SUM(CASE WHEN e.account=ANY($3::text[]) THEN CASE WHEN e.direction='credit' THEN e.amount_minor ELSE -e.amount_minor END ELSE 0 END),0)::text AS tenant_balance_delta_minor
       FROM ledger_transactions t LEFT JOIN ledger_entries e ON e.transaction_id=t.transaction_id
      WHERE t.tenant_id=$1 AND t.status='posted' GROUP BY t.transaction_id ORDER BY t.posted_at DESC,t.transaction_id DESC LIMIT $2 OFFSET $4`, [tenantId, limit, [...tenantBalanceAccounts], offset]
  );
  return result.rows;
}
