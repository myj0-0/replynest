import {pool} from './database.js';
import {planClaimPressure} from './automation-plan-queue.js';
import {createRuntimeMonitor,runtimeCounters} from './automation-runtime-health.js';

export const automationRuntimeMonitor=createRuntimeMonitor(async()=>{
 const c=await pool.connect();
 try{
  await c.query('BEGIN READ ONLY');await c.query("SET LOCAL statement_timeout='2s'");await c.query("SET LOCAL lock_timeout='250ms'");
  // Both samples use partial state indexes and a hard row limit. Do not scan
  // completed history for a public health request or exact global totals.
  const pending=(await c.query("SELECT created_at,scheduled_at,source FROM tenant_automation_plan_runs WHERE state='pending' ORDER BY tenant_id,created_at,run_id LIMIT 501")).rows;
  const running=(await c.query("SELECT lease_expires_at FROM tenant_automation_plan_runs WHERE state='running' ORDER BY lease_expires_at LIMIT 501")).rows;
  await c.query('COMMIT');const at=Date.now();
  return {at,pending:Math.min(500,pending.length),pending_capped:pending.length>500,
   oldest_seconds:Math.max(0,...pending.map(r=>(at-new Date(r.source==='schedule'?r.scheduled_at:r.created_at).getTime())/1000)),
   expired_running:running.filter(r=>!r.lease_expires_at||new Date(r.lease_expires_at).getTime()<=at).length,
   pool_waiting:pool.waitingCount,rejected:pool.pressure.rejected,timeouts:pool.pressure.timeouts,claim_lock_timeouts:planClaimPressure.lockTimeouts,
   scheduler_errors:runtimeCounters.scheduler_errors,planner_errors:runtimeCounters.planner_errors,partial:runtimeCounters.partial,failed:runtimeCounters.failed};
 }catch(e){try{await c.query('ROLLBACK');}catch{/* Preserve original sanitized failure classification. */}throw e;}finally{c.release();}
},()=>runtimeCounters);
export function startAutomationRuntimeMonitor(){
 const active=new Set<Promise<unknown>>();let stopped=false;
 const run=()=>{if(stopped)return;const p=automationRuntimeMonitor.refresh();active.add(p);void p.finally(()=>active.delete(p)).catch(()=>{});};
 run();const timer=setInterval(run,30000);timer.unref();
 return async()=>{stopped=true;clearInterval(timer);await Promise.allSettled([...active]);};
}
