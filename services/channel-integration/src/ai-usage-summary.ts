import {pool} from './database.js';
export const aiUsageSummarySchema=`CREATE TABLE IF NOT EXISTS ai_usage_admin_summary(
 id INTEGER PRIMARY KEY CHECK(id=1),payload JSONB,computed_at TIMESTAMPTZ,
 attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),error_code TEXT
);
CREATE INDEX IF NOT EXISTS ai_usage_admin_window_idx ON ai_usage_calls(created_at);
`;
export async function readAiUsageSummary(){
 const row=(await pool.query('SELECT payload,computed_at,error_code FROM ai_usage_admin_summary WHERE id=1')).rows[0];
 return {usage:row?.payload??[],usage_computed_at:row?.computed_at??null,
  usage_status:!row?.computed_at?'warming':row.error_code||Date.now()-+new Date(row.computed_at)>300_000?'stale':'ready'};
}
// Refresh only in the background, never from an HTTP request. Failed refresh retains last good data.
export async function refreshAiUsageSummary(){
 const db=await pool.connect();let locked=false,destroy=false;
 try{
  locked=Boolean((await db.query("SELECT pg_try_advisory_lock(hashtext('ai-usage-admin-summary')) AS locked")).rows[0].locked);if(!locked)return false;
  const old=(await db.query("SELECT attempted_at>NOW()-INTERVAL '90 seconds' AS fresh FROM ai_usage_admin_summary WHERE id=1")).rows[0];if(old?.fresh)return false;
  try{
   await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='5s'");await db.query("SET LOCAL lock_timeout='500ms'");
   const now=(await db.query('SELECT NOW() AS ts')).rows[0].ts;
   const rows=(await db.query(`SELECT model,count(*)::int AS calls,count(*) FILTER(WHERE cost_nano_cny IS NULL)::int AS unknown_cost_calls,
    COALESCE(SUM(input_tokens),0)::text AS input_tokens,COALESCE(SUM(output_tokens),0)::text AS output_tokens,
    COALESCE(SUM(cached_input_tokens),0)::text AS cached_input_tokens,COALESCE(SUM(cost_nano_cny),0)::text AS cost_nano_cny,
    COALESCE(SUM(charged_micros),0)::text AS charged_micros FROM ai_usage_calls
    WHERE created_at>$1::timestamptz-INTERVAL '30 days' AND created_at<=$1 GROUP BY model ORDER BY model`,[now])).rows;
   await db.query(`INSERT INTO ai_usage_admin_summary(id,payload,computed_at,attempted_at)VALUES(1,$1,$2,NOW())
    ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,computed_at=EXCLUDED.computed_at,attempted_at=NOW(),error_code=NULL`,[JSON.stringify(rows),now]);
   await db.query('COMMIT');return true;
  }catch{
   await db.query('ROLLBACK');
   await db.query(`INSERT INTO ai_usage_admin_summary(id,error_code)VALUES(1,'refresh_failed')
    ON CONFLICT(id) DO UPDATE SET attempted_at=NOW(),error_code='refresh_failed'`);return false;
  }
 }finally{try{if(locked)await db.query("SELECT pg_advisory_unlock(hashtext('ai-usage-admin-summary'))");}catch{destroy=true;}finally{db.release(destroy);}}
}
