import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { postLedgerTransaction } from "./ledger.js";

type OutboxRow = {
  outbox_id: string;
  tenant_id: string;
  payment_order_id: string;
  payment_event_id: string;
  operation: "settle" | "refund" | "chargeback";
  amount_minor: string;
  currency: string;
  occurred_at: Date;
};

async function claim(limit: number) {
  const result = await pool.query<OutboxRow>(`
    WITH candidates AS (
      SELECT outbox_id FROM payment_ledger_outbox
       WHERE (status='pending' AND available_at<=NOW()) OR (status='processing' AND lease_until<NOW())
       ORDER BY created_at,outbox_id FOR UPDATE SKIP LOCKED LIMIT $1
    )
    UPDATE payment_ledger_outbox o SET status='processing',attempt_count=attempt_count+1,lease_until=NOW()+INTERVAL '2 minutes',updated_at=NOW()
      FROM candidates c,payment_events e
     WHERE o.outbox_id=c.outbox_id AND e.payment_event_id=o.payment_event_id
    RETURNING o.outbox_id,o.tenant_id,o.payment_order_id,o.payment_event_id,o.operation,o.amount_minor::text,o.currency,e.occurred_at`, [limit]);
  return result.rows;
}

async function project(row: OutboxRow) {
  const amount = Number(row.amount_minor);
  const settlement = row.operation === "settle";
  const purchase = await pool.query(`SELECT 1 FROM plan_payment_purchases WHERE payment_order_id=$1 AND tenant_id=$2`, [row.payment_order_id,row.tenant_id]);
  const account = purchase.rowCount ? "revenue" as const : "cash" as const;
  const ledger = await postLedgerTransaction(row.tenant_id, {
    transaction_type: settlement ? (purchase.rowCount ? "charge" : "topup") : "refund",
    currency: row.currency,
    idempotency_key: `payment:${row.payment_event_id}:${row.operation}`,
    source_type: "payment_event",
    source_id: row.payment_event_id,
    occurred_at: row.occurred_at.toISOString(),
    metadata: { payment_order_id: row.payment_order_id, payment_event_id: row.payment_event_id, operation: row.operation },
    entries: settlement
      ? [{ account: "clearing", direction: "debit", amount_minor: amount }, { account, direction: "credit", amount_minor: amount }]
      : [{ account, direction: "debit", amount_minor: amount }, { account: "clearing", direction: "credit", amount_minor: amount }]
  }, { actor_id: "payment-ledger-outbox", request_id: randomUUID() });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE payment_orders SET ledger_transaction_id=CASE WHEN $3='settle' THEN $2 ELSE ledger_transaction_id END,reversal_ledger_transaction_id=CASE WHEN $3<>'settle' THEN $2 ELSE reversal_ledger_transaction_id END,updated_at=NOW() WHERE tenant_id=$1 AND payment_order_id=$4`, [row.tenant_id, ledger.transaction_id, row.operation, row.payment_order_id]);
    await client.query(`UPDATE payment_ledger_outbox SET status='succeeded',ledger_transaction_id=$2,lease_until=NULL,last_error_code=NULL,updated_at=NOW() WHERE outbox_id=$1 AND status='processing'`, [row.outbox_id, ledger.transaction_id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function processPaymentLedgerOutbox(limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid outbox batch size");
  const rows = await claim(limit);
  let succeeded = 0;
  for (const row of rows) {
    try {
      await project(row);
      succeeded += 1;
    } catch (error) {
      const code = error instanceof Error ? error.name.slice(0, 100) : "UnknownError";
      await pool.query(`UPDATE payment_ledger_outbox SET status=CASE WHEN attempt_count>=5 THEN 'dead' ELSE 'pending' END,available_at=NOW()+(LEAST(300,POWER(2,attempt_count))::text||' seconds')::interval,lease_until=NULL,last_error_code=$2,updated_at=NOW() WHERE outbox_id=$1 AND status='processing'`, [row.outbox_id, code]);
    }
  }
  return { claimed: rows.length, succeeded, failed: rows.length - succeeded };
}
