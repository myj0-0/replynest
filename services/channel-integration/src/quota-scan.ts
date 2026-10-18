import type {PoolClient} from 'pg';
import {pool} from './database.js';

export const quotaScanSchema = `
 CREATE TABLE IF NOT EXISTS quota_scan_state (
  worker_key TEXT PRIMARY KEY CHECK(worker_key='quota-warnings'),
  cursor_id TEXT,
  upper_id TEXT,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cycle_started_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  completed_cycles BIGINT NOT NULL DEFAULT 0,
  scanned BIGINT NOT NULL DEFAULT 0,
  failed BIGINT NOT NULL DEFAULT 0,
  last_error_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );
 CREATE INDEX IF NOT EXISTS quota_scan_tenants_idx ON tenants(tenant_id) WHERE status IN ('active','test');
`;

// Fixed worker identity, no tenant data in logs. Checkpoint and work commit together.
// A failed tenant is counted and revisited next cycle, never blocks later tenants.
export async function runQuotaScan(
 visit:(tenant:string,db:PoolClient)=>Promise<number>,
 afterScan:()=>Promise<number>=async()=>0,
){
 const db=await pool.connect();let locked=false;
 const result={scanned:0,failed:0,created:0,emitted:0,completed:false,skipped:false};
 try{
  locked=Boolean((await db.query("SELECT pg_try_advisory_lock(hashtext('quota-warning-scan-v2')) AS locked")).rows[0].locked);
  if(!locked)return {...result,skipped:true};
  await db.query("INSERT INTO quota_scan_state(worker_key) VALUES('quota-warnings') ON CONFLICT DO NOTHING");
  const state=(await db.query("SELECT *,next_run_at<=NOW() AS due FROM quota_scan_state WHERE worker_key='quota-warnings'")).rows[0];
  if(state.due){
   let upper=state.upper_id as string|null,cursor=state.cursor_id as string|null;
   if(upper===null){
    upper=(await db.query("SELECT tenant_id FROM tenants WHERE status IN ('active','test') ORDER BY tenant_id DESC LIMIT 1")).rows[0]?.tenant_id??null;
    cursor=null;
    await db.query("UPDATE quota_scan_state SET upper_id=$1,cursor_id=NULL,cycle_started_at=NOW(),updated_at=NOW() WHERE worker_key='quota-warnings'",[upper]);
   }
   // An upper bound makes each cycle finite even while new tenants are registering.
   const tenants=(await db.query<{tenant_id:string}>(`SELECT tenant_id FROM tenants WHERE status IN ('active','test')
    AND tenant_id<=$1 AND ($2::text IS NULL OR tenant_id>$2) ORDER BY tenant_id LIMIT 101`,[upper,cursor])).rows;
   const deadline=Date.now()+10_000;
   for(const tenant of tenants.slice(0,100)){
    if(Date.now()>=deadline)break;
    let created=0,failed=false;
    try{
     await db.query('BEGIN');
     await db.query("SET LOCAL statement_timeout='2s'");
     await db.query("SET LOCAL lock_timeout='500ms'");
     created=await visit(tenant.tenant_id,db);
     await db.query("UPDATE quota_scan_state SET cursor_id=$1,scanned=scanned+1,updated_at=NOW() WHERE worker_key='quota-warnings'",[tenant.tenant_id]);
     await db.query('COMMIT');
    }catch{
     await db.query('ROLLBACK');failed=true;
     await db.query(`UPDATE quota_scan_state SET cursor_id=$1,scanned=scanned+1,failed=failed+1,
      last_error_code='tenant_scan_failed',updated_at=NOW() WHERE worker_key='quota-warnings'`,[tenant.tenant_id]);
    }
    result.scanned++;if(failed)result.failed++;else result.created+=created;
   }
   result.completed=tenants.length<=100&&result.scanned===tenants.length;
   if(result.completed)await db.query(`UPDATE quota_scan_state SET cursor_id=NULL,upper_id=NULL,
    completed_cycles=completed_cycles+1,last_completed_at=NOW(),next_run_at=NOW()+INTERVAL '5 minutes',updated_at=NOW()
    WHERE worker_key='quota-warnings'`);
   else await db.query("UPDATE quota_scan_state SET next_run_at=NOW()+INTERVAL '15 seconds' WHERE worker_key='quota-warnings'");
  }
  // Keep delivery bounded and under the same cross-process lock, even during cooldown.
  result.emitted=await afterScan();
  return result;
 }finally{
  let destroy=false;
  try{if(locked)await db.query("SELECT pg_advisory_unlock(hashtext('quota-warning-scan-v2'))");}
  catch{destroy=true;throw new Error('quota_scan_unlock_failed');}
  finally{db.release(destroy);}
 }
}
