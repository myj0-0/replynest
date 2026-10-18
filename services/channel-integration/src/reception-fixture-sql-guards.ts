/** Fixture-only observation: pg_stat_activity may lag a COMMIT, so inspect
 * actual granted transaction-ID locks, not the cached backend_xid alone.
 * Empty concurrent queue claims do not hold a tuple protection transaction.
 * This checks row/write guards, NOT absence of every read-only transaction. */
const formalRole=process.env.RECEPTION_FORMAL_RUNTIME;
if(formalRole!==undefined&&formalRole!=='isolated-formal-reception')throw Error('fixed_formal_fixture_runtime_required');
export const receptionFixtureSqlGuards=`SELECT count(DISTINCT a.pid) n FROM pg_stat_activity a
 JOIN pg_locks l ON l.pid=a.pid AND l.locktype='transactionid' AND l.mode='ExclusiveLock' AND l.granted
 WHERE a.usename='${formalRole?'replynest_runtime':'history_runtime'}' AND a.state='idle in transaction'`;

/** Observe the SAME persisted job using the scheduler's database clock.
 * Test-only: never edits due_at, advances a clock, or dispatches before due.
 * Node wall time can disagree with PG during a local VM clock adjustment;
 * monotonic time bounds this observation rather than assuming clock agreement. */
export async function waitForFixtureDatabaseDue(db:{query:(sql:string,values:string[])=>Promise<{rows:any[]}>},jobId:string,deadlineKind:'due'|'expires'='due'){
 if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(jobId))throw Error('fixed_fixture_job_required');
 if(!['due','expires'].includes(deadlineKind))throw Error('fixed_fixture_deadline_required');
 const field=deadlineKind==='due'?'w.due_at':'w.expires_at';
 const deadline=performance.now()+35000;
 for(;;){
  const row=(await db.query(`SELECT w.state wait_state,j.state job_state,
   clock_timestamp()>=${field} ready,
   (EXTRACT(EPOCH FROM (${field}-clock_timestamp()))*1000)::float8 remaining_ms
   FROM automatic_reply_waits w JOIN automatic_reception_jobs j USING(job_id) WHERE w.job_id=$1`,[jobId])).rows[0];
  if(!row||row.wait_state!=='waiting'||row.job_state!=='processing'||typeof row.ready!=='boolean'||
   typeof row.remaining_ms!=='number'||!Number.isFinite(row.remaining_ms)||row.remaining_ms>30000)
   throw Error('fixture_wait_record_not_observable');
  if(row.ready&&row.remaining_ms<=0)return;
  if(performance.now()>=deadline)throw Error('fixture_due_observation_deadline');
  await new Promise(resolve=>setTimeout(resolve,Math.min(1000,Math.max(10,Math.ceil(row.remaining_ms)+30))));
 }
}

/** Observe a saved synthetic ingress after a VM wall-clock rollback. No intake
 * retry, record mutation or provider call. The actual intake must still succeed
 * on its single invocation and all production admission checks remain intact. */
export async function waitForFixtureRecordedIngressClock(db:{query:(sql:string,values:string[])=>Promise<{rows:any[]}>},appId:string,messageId:string){
 if(!/^wx[a-f0-9]{16}$/.test(appId)||! /^[1-9]\d{0,18}$/.test(messageId))throw Error('fixed_fixture_ingress_required');
 const deadline=performance.now()+10000;
 for(;;){
  const row=(await db.query(`SELECT r.source_occurred_at<=clock_timestamp() AND d.created_at<=clock_timestamp() ready,
   (EXTRACT(EPOCH FROM (GREATEST(r.source_occurred_at,d.created_at)-clock_timestamp()))*1000)::float8 remaining_ms
   FROM shared_wechat_deliveries d JOIN shared_wechat_receipts r ON r.app_id=d.app_id AND r.event_id=d.command_id
    AND r.open_id=d.open_id AND r.destination_tenant_id=d.tenant_id
   WHERE d.app_id=$1 AND d.upstream_message_id=$2 AND d.direction='in' AND d.status='delivered'
    AND r.delivery_state='held' AND r.decision->>'action'='route'`,[appId,messageId])).rows[0];
  if(!row||typeof row.ready!=='boolean'||typeof row.remaining_ms!=='number'||!Number.isFinite(row.remaining_ms)||row.remaining_ms>3000)
   throw Error('fixture_ingress_clock_not_observable');
  if(row.ready&&row.remaining_ms<=0)return;
  if(performance.now()>=deadline)throw Error('fixture_ingress_clock_deadline');
  await new Promise(resolve=>setTimeout(resolve,Math.min(1000,Math.max(10,Math.ceil(row.remaining_ms)+30))));
 }
}
