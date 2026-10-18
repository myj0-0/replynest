import type {PoolClient} from 'pg';

export const PLAN_CONCURRENCY=4;
export const planClaimPressure={lockTimeouts:0};
// Four execution lanes must not compete with each other for the SAME database
// admission lock. Serialize only local claims, not plan execution. Replicas still
// use the existing database lock, cap, fairness and fenced lease checks.
let localClaimTurn:Promise<void>=Promise.resolve();
export async function serializeAutomationClaim<T>(claim:()=>Promise<T>):Promise<T>{
 const prior=localClaimTurn;let release!:()=>void;
 localClaimTurn=new Promise<void>(resolve=>{release=resolve;});
 await prior;try{return await claim();}finally{release();}
}
// Short database-only lock serializes claims across replicas. Never held while
// contacting Chatwoot. Only a current lease can commit results.
export async function claimAutomationPlan(c:PoolClient){
 await c.query('BEGIN');
 let waitingForClaimLock=false;
 try{
  await c.query("SET LOCAL statement_timeout='3s'");
  await c.query("SET LOCAL lock_timeout='500ms'");
  waitingForClaimLock=true;
  await c.query("SELECT pg_advisory_xact_lock(hashtext('automation-plan-claim-v2'))");
  waitingForClaimLock=false;
  await c.query(`UPDATE tenant_automation_plan_runs SET
   state=CASE WHEN claim_attempts<2 AND lease_token IS NOT NULL
    AND ((source IN('schedule','event') AND scheduled_at>=NOW()-INTERVAL '5 minutes')
      OR (source='manual' AND created_at>=NOW()-INTERVAL '15 minutes')) THEN 'pending' ELSE 'interrupted' END,
   completed_at=CASE WHEN claim_attempts<2 AND lease_token IS NOT NULL
    AND ((source IN('schedule','event') AND scheduled_at>=NOW()-INTERVAL '5 minutes')
      OR (source='manual' AND created_at>=NOW()-INTERVAL '15 minutes')) THEN NULL ELSE NOW() END,
   lease_token=NULL,lease_expires_at=NULL
   WHERE state='running' AND (lease_expires_at<=NOW()
     OR (lease_expires_at IS NULL AND started_at<NOW()-INTERVAL '5 minutes'))`);
  const running=await c.query("SELECT COUNT(*)::int n FROM tenant_automation_plan_runs WHERE state='running'");
  if(running.rows[0].n>=PLAN_CONCURRENCY){await c.query('COMMIT');return undefined;}
  const run=(await c.query(`WITH heads AS (
   SELECT DISTINCT ON (tenant_id) tenant_id,run_id,created_at
   FROM tenant_automation_plan_runs p WHERE state='pending'
   AND NOT EXISTS(SELECT 1 FROM tenant_automation_plan_runs busy WHERE busy.state='running' AND busy.tenant_id=p.tenant_id)
   AND ((source IN('schedule','event') AND scheduled_at>=NOW()-INTERVAL '5 minutes')
     OR (source='manual' AND created_at>=NOW()-INTERVAL '15 minutes'))
   ORDER BY tenant_id,created_at,run_id
  ), candidate AS (
   SELECT h.tenant_id,h.run_id FROM heads h
   LEFT JOIN tenant_automation_plan_fairness f USING(tenant_id)
   ORDER BY f.last_claimed_at ASC NULLS FIRST,h.created_at,h.tenant_id LIMIT 1
  ) UPDATE tenant_automation_plan_runs r SET state='running',started_at=clock_timestamp(),
   lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+INTERVAL '90 seconds',claim_attempts=claim_attempts+1
   FROM candidate c WHERE r.tenant_id=c.tenant_id AND r.run_id=c.run_id AND r.state='pending'
   RETURNING r.*`)).rows[0];
  if(run)await c.query(`INSERT INTO tenant_automation_plan_fairness(tenant_id,last_claimed_at)
   VALUES($1,clock_timestamp()) ON CONFLICT(tenant_id) DO UPDATE SET last_claimed_at=EXCLUDED.last_claimed_at`,[run.tenant_id]);
  await c.query('COMMIT');return run;
 }catch(error){
  await c.query('ROLLBACK');
  // Contention on the admission lock is not a failed plan. Nothing was claimed;
  // the bounded poll can retry. Never suppress row-lock or statement failures.
  if(waitingForClaimLock&&(error as {code?:string}).code==='55P03'){
   planClaimPressure.lockTimeouts++;return undefined;
  }
  throw error;
 }
}

export type PlanLease={tenant_id:string;run_id:string;lease_token:string};
export async function hasPlanLease(c:Pick<PoolClient,'query'>,run:PlanLease){
 return Boolean((await c.query(`SELECT 1 FROM tenant_automation_plan_runs
  WHERE tenant_id=$1 AND run_id=$2 AND state='running' AND lease_token=$3
  AND lease_expires_at>clock_timestamp()`,[run.tenant_id,run.run_id,run.lease_token])).rowCount);
}

// Caller uses the same transaction for this update and its completion audit.
export async function finishAutomationPlan(c:PoolClient,run:PlanLease,state:string,result:unknown){
 return Boolean((await c.query(`UPDATE tenant_automation_plan_runs SET state=$4,result=$5::jsonb,
  completed_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL
  WHERE tenant_id=$1 AND run_id=$2 AND lease_token=$3 AND state='running'
  AND lease_expires_at>clock_timestamp()`,[run.tenant_id,run.run_id,run.lease_token,state,JSON.stringify(result)])).rowCount);
}
