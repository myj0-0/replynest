import type {Pool} from 'pg';
import {giftLots} from './wallet-core.js';

// Explicit maintenance operation, not a balance-request or automatic fallback path.
// Returns counts only; never includes ledger metadata or customer data.
export async function reconcileAiPointFunding(db:Pool,tenant:string){
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  await c.query("SET LOCAL statement_timeout='15s'");
  await c.query("SET LOCAL lock_timeout='2s'");
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`wallet:${tenant}`]);
  const now=(await c.query('SELECT clock_timestamp() AS ts')).rows[0].ts;
  const entries=(await c.query(`SELECT e.*,t.posted_at,t.transaction_type,t.metadata,t.reversal_of
   FROM ledger_entries e JOIN ledger_transactions t USING(transaction_id)
   WHERE e.tenant_id=$1 AND e.account='ai_credit' AND e.currency='AIC' AND t.status='posted'
   ORDER BY t.posted_at,t.transaction_id,e.entry_id`,[tenant])).rows;
  const expected=giftLots(entries,now);
  const actual=(await c.query(`SELECT entry_id,remaining_minor::text AS amount_minor,expires_at FROM ai_point_funding_lots
   WHERE tenant_id=$1 AND remaining_minor>0 AND (expires_at IS NULL OR expires_at>$2)`,[tenant,now])).rows;
  const normalize=(rows:any[])=>new Map(rows.map(r=>[r.entry_id,JSON.stringify([String(r.amount_minor),r.expires_at?new Date(r.expires_at).toISOString():null])]));
  const left=normalize(expected),right=normalize(actual);
  const lotDifferences=[...new Set([...left.keys(),...right.keys()])].filter(id=>left.get(id)!==right.get(id)).length;
  const refund=(await c.query(`WITH source AS (
   SELECT entry_id,SUM(point_micros)::bigint amount FROM ai_point_refunds
    WHERE tenant_id=$1 AND status IN ('requested','approved') GROUP BY entry_id
   ),projected AS(SELECT entry_id,held_micros amount FROM ai_point_refund_usage WHERE tenant_id=$1)
   SELECT count(*)::int AS differences FROM source s FULL JOIN projected p USING(entry_id)
   WHERE COALESCE(s.amount,0)<>COALESCE(p.amount,0)`,[tenant])).rows[0].differences;
  await c.query('COMMIT');
  return {matches:lotDifferences===0&&refund===0,lot_differences:lotDifferences,refund_differences:refund,active_lots:expected.length};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
