import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { recordProviderPaymentEvent } from "./payment-order.js";
import { paymentQueryEventId, paymentQueryRetryDelaySeconds, validatePaymentQueryResult, type PaymentQueryOrder, type PaymentQueryResult } from "./payment-query-core.js";

export type PaymentQueryAdapter = { query(order: PaymentQueryOrder): Promise<PaymentQueryResult> };
type QueryJob = PaymentQueryOrder & { query_job_id: string; tenant_id: string; payment_order_id: string; attempt_count: number; max_attempts: number; worker_id:string };

const enabled = () => process.env.PAYMENT_ORDER_QUERY_ENABLED === "true";
const intervalSeconds = () => Math.max(60, Number(process.env.PAYMENT_ORDER_QUERY_INTERVAL_SECONDS ?? 300));

export async function schedulePaymentQueries(now = new Date()): Promise<number> {
  if (!enabled()) return 0;
  const slot = new Date(Math.floor(now.getTime() / (intervalSeconds() * 1000)) * intervalSeconds() * 1000);
  const result = await pool.query(
    `INSERT INTO payment_order_query_jobs(tenant_id,payment_order_id,provider,slot_started_at)
     SELECT o.tenant_id,o.payment_order_id,o.provider,$1
       FROM payment_orders o
      WHERE o.status='pending_payment' AND o.provider IN ('wechat_pay','alipay')
        AND o.created_at <= $1::timestamptz-($2::int*INTERVAL '1 second')
        AND NOT EXISTS(SELECT 1 FROM payment_order_query_jobs j WHERE j.payment_order_id=o.payment_order_id AND j.status IN ('pending','retry_pending','processing'))
     ON CONFLICT(payment_order_id,slot_started_at) DO NOTHING`,
    [slot.toISOString(), intervalSeconds()]
  );
  return result.rowCount ?? 0;
}

async function claimPaymentQueries(limit: number): Promise<QueryJob[]> {
  const worker = `payment-query-${randomUUID()}`;
  const result = await pool.query<QueryJob>(
    `WITH candidates AS (
       SELECT query_job_id FROM payment_order_query_jobs
        WHERE (status IN ('pending','retry_pending') AND available_at<=NOW())
           OR (status='processing' AND lease_until<NOW())
        ORDER BY available_at,created_at LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE payment_order_query_jobs j SET status='processing',attempt_count=j.attempt_count+1,
       lease_until=NOW()+INTERVAL '45 seconds',worker_id=$2,updated_at=NOW()
     FROM candidates c, payment_orders o
     WHERE j.query_job_id=c.query_job_id AND o.payment_order_id=j.payment_order_id
     RETURNING j.query_job_id,j.tenant_id,j.payment_order_id,j.provider,j.attempt_count,j.max_attempts,j.worker_id,
       o.order_number,o.provider_order_id,o.amount_minor::float8,o.currency,
       (SELECT payment_mode FROM plan_payment_purchases p WHERE p.payment_order_id=o.payment_order_id) AS payment_mode,
       (SELECT expires_at FROM plan_payment_purchases p WHERE p.payment_order_id=o.payment_order_id) AS expires_at`,
    [Math.max(1, Math.min(limit, 50)), worker]
  );
  return result.rows;
}

async function appendQueryEvent(job: QueryJob, outcome: string, reason: string, detail: Record<string, unknown> = {}) {
  await pool.query(
    `INSERT INTO payment_order_query_events(query_job_id,tenant_id,payment_order_id,outcome,reason,detail)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [job.query_job_id, job.tenant_id, job.payment_order_id, outcome, reason, detail]
  );
}

async function complete(job: QueryJob, result: PaymentQueryResult) {
  const updated=await pool.query(`UPDATE payment_order_query_jobs SET status='succeeded',lease_until=NULL,worker_id=NULL,last_error_code=NULL,result_state=$2,completed_at=NOW(),updated_at=NOW() WHERE query_job_id=$1 AND worker_id=$3 AND status='processing'`, [job.query_job_id, result.state,job.worker_id]);
  if(updated.rowCount)await appendQueryEvent(job, "succeeded", `provider_${result.state}`);
}

async function fail(job: QueryJob, error: unknown) {
  const code = error instanceof Error ? error.message.slice(0, 120) : "query_unknown_error";
  const permanent = /mismatch|incomplete|adapter_disabled/.test(code);
  const dead = permanent || job.attempt_count >= job.max_attempts;
  const delay = paymentQueryRetryDelaySeconds(job.attempt_count);
  const updated=await pool.query(
    `UPDATE payment_order_query_jobs SET status=$2,lease_until=NULL,worker_id=NULL,last_error_code=$3,
       available_at=CASE WHEN $2='dead' THEN available_at ELSE NOW()+($4::int*INTERVAL '1 second') END,
       completed_at=CASE WHEN $2='dead' THEN NOW() ELSE NULL END,updated_at=NOW() WHERE query_job_id=$1 AND worker_id=$5 AND status='processing'`,
    [job.query_job_id, dead ? "dead" : "retry_pending", code, delay,job.worker_id]
  );
  if(updated.rowCount)await appendQueryEvent(job, dead ? "dead" : "retry_pending", code, { retry_in_seconds: dead ? null : delay });
}

export async function processPaymentQueries(adapters: Partial<Record<"wechat_pay" | "alipay", PaymentQueryAdapter>> = {}, limit = 10) {
  if (!enabled()) return { claimed: 0, succeeded: 0, failed: 0 };
  const jobs = await claimPaymentQueries(limit);
  let succeeded = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      const adapter = adapters[job.provider];
      if (!adapter) throw new Error("payment_query_adapter_disabled");
      const result = validatePaymentQueryResult(job, await adapter.query(job));
      if (result.state === "paid") {
        await recordProviderPaymentEvent(job.tenant_id, job.payment_order_id, job.provider, {
          provider_event_id: paymentQueryEventId(result), event_type: "payment_succeeded",
          amount_minor: result.amount_minor!, currency: result.currency!, occurred_at: result.paid_at!, provider_order_id: result.provider_order_id
        }, { actor_id: "payment-query-worker", request_id: randomUUID() });
      }
      if (result.state === 'closed') {
        await recordProviderPaymentEvent(job.tenant_id,job.payment_order_id,job.provider,{
          provider_event_id:`query-closed:${job.query_job_id}`,event_type:'payment_cancelled',amount_minor:0,currency:job.currency,
          occurred_at:new Date().toISOString(),provider_order_id:result.provider_order_id
        },{actor_id:'payment-query-worker',request_id:randomUUID()});
      }
      if(result.state==='unknown')throw new Error('provider_state_unknown');
      await complete(job, result);
      succeeded += 1;
    } catch (error) { await fail(job, error); failed += 1; }
  }
  return { claimed: jobs.length, succeeded, failed };
}

export async function paymentQueryHealth() {
  const result = await pool.query<{ pending: string; dead: string; oldest_seconds: string | null }>(
    `SELECT COUNT(*) FILTER(WHERE status IN ('pending','retry_pending','processing'))::text AS pending,
       COUNT(*) FILTER(WHERE status='dead')::text AS dead,
       EXTRACT(EPOCH FROM NOW()-MIN(created_at) FILTER(WHERE status IN ('pending','retry_pending','processing')))::text AS oldest_seconds
     FROM payment_order_query_jobs`
  );
  const pending = Number(result.rows[0].pending), dead = Number(result.rows[0].dead), oldest = Math.round(Number(result.rows[0].oldest_seconds ?? 0));
  return { status: !enabled() ? "execution_disabled" : dead > 0 || oldest > 900 ? "degraded" : "operational", enabled: enabled(), pending, dead, oldest_seconds: oldest };
}
