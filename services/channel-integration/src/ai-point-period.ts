import type {PoolClient} from 'pg';
import {refundAiCycleAnchor} from './ai-refund-cycle.js';

// One original anchor, not repeated addition to the previous (possibly clamped)
// boundary: Jan 31 -> Feb 28 -> Mar 31. Compute with the database clock so reads
// and reservations cannot disagree because application/server clocks differ.
export async function aiPointPeriod(db:Pick<PoolClient,'query'>,tenant:string,entitlement:any){
 const s=entitlement.subscription;
 const retained=entitlement.plan.code==='free'&&entitlement.source!=='trial'?await refundAiCycleAnchor(db,tenant):null;
 const raw=entitlement.plan.code==='free'&&entitlement.source!=='trial'?retained:
  s.entitlement_snapshot?.ai_cycle_anchor??s.current_period_start;
 if(raw!==null&&raw!==undefined&&!Number.isFinite(+new Date(raw)))throw Error('invalid_ai_cycle_anchor');
 const anchor=raw??null;
 const row=(await db.query(`WITH basis AS (
  SELECT timezone, NOW() AT TIME ZONE timezone AS local_now,
   $2::timestamptz AT TIME ZONE timezone AS anchor FROM tenants WHERE tenant_id=$1
 ), candidate AS (
  SELECT *, CASE WHEN anchor IS NULL THEN 0 ELSE
   (EXTRACT(YEAR FROM local_now)::int-EXTRACT(YEAR FROM anchor)::int)*12+
   EXTRACT(MONTH FROM local_now)::int-EXTRACT(MONTH FROM anchor)::int END AS months FROM basis
 ), numbered AS (
  SELECT *, months-CASE WHEN anchor+months*INTERVAL '1 month'>local_now THEN 1 ELSE 0 END AS n FROM candidate
 ), boundaries AS (
  SELECT timezone,anchor,
   COALESCE(anchor+n*INTERVAL '1 month',date_trunc('month',local_now)) AT TIME ZONE timezone AS period_start,
   COALESCE(anchor+(n+1)*INTERVAL '1 month',date_trunc('month',local_now)+INTERVAL '1 month') AT TIME ZONE timezone AS next_reset
  FROM numbered
 ) SELECT timezone,period_start,
  CASE WHEN anchor IS NULL THEN next_reset ELSE LEAST(next_reset,$3::timestamptz) END AS period_end,
  CASE WHEN anchor IS NULL THEN 'calendar_month' ELSE 'subscription_month' END AS period_policy
 FROM boundaries`,[tenant,anchor,retained?null:anchor? s.grace_ends_at??s.current_period_end:null])).rows[0];
 if(!row)throw Error('tenant not found');
 return row;
}
