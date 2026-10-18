// Process-local counters: never store tenant identifiers, content or raw errors.
const reasons=['read_failed','scan_limit','time_limit','plan_validation_failed','authorization_revoked','other'] as const;
type Reason=typeof reasons[number];
export const runtimeCounters={scheduler_errors:0,planner_errors:0,completed:0,partial:0,failed:0,cancelled:0,
 reasons:Object.fromEntries(reasons.map(r=>[r,0])) as Record<Reason,number>};
export function recordPlanOutcome(state:string,code:string|null,readFailed:boolean){
 if(['completed','partial','failed','cancelled'].includes(state))runtimeCounters[state as 'completed'|'partial'|'failed'|'cancelled']++;
 if(state!=='completed'){
  const reason=readFailed?'read_failed':reasons.includes(code as Reason)?code as Reason:'other';
  runtimeCounters.reasons[reason]++;
 }
}
export type RuntimeSample={at:number;pending:number;pending_capped:boolean;oldest_seconds:number;expired_running:number;
 pool_waiting:number;rejected:number;timeouts:number;claim_lock_timeouts:number;scheduler_errors:number;planner_errors:number;partial:number;failed:number};
const counterKeys=['rejected','timeouts','claim_lock_timeouts','scheduler_errors','planner_errors','partial','failed'] as const;
export function samplingFailureCode(error:unknown):string{
 const code=error&&typeof error==='object'&&'code' in error?error.code:undefined;
 const codes:Record<string,string>={database_busy:'connection_pool_busy','55P03':'sampling_lock_timeout','57014':'sampling_statement_timeout',
  '42501':'sampling_permission_denied','42P01':'sampling_schema_missing','53300':'database_connections_exhausted',
  '57P01':'database_restarting','ECONNREFUSED':'database_unreachable','ECONNRESET':'database_connection_reset',
  'ETIMEDOUT':'database_connection_timeout'};
 return typeof code==='string'&&Object.hasOwn(codes,code)?codes[code]:'sampling_failed';
}
export function runtimeStatus(current:RuntimeSample,baseline:RuntimeSample){
 const pressure=current.rejected>baseline.rejected||current.timeouts>baseline.timeouts||current.pool_waiting>=20;
 const errors=current.scheduler_errors>baseline.scheduler_errors||current.planner_errors>baseline.planner_errors||current.partial>baseline.partial||current.failed>baseline.failed;
 return {status:pressure||errors||current.oldest_seconds>=120||current.expired_running>0||current.claim_lock_timeouts>baseline.claim_lock_timeouts?'degraded' as const:'operational' as const,
  reasons:[...(pressure?['database_pressure']:[]),...(errors?['planning_errors']:[]),...(current.oldest_seconds>=120?['queue_delay']:[]),...(current.expired_running>0?['expired_lease']:[]),...(current.claim_lock_timeouts>baseline.claim_lock_timeouts?['claim_contention']:[])]};
}

export function createRuntimeMonitor(collect:()=>Promise<RuntimeSample>,details:()=>unknown,now=Date.now){
 const processStartedAt=new Date(now()).toISOString();
 let running=false;
 let last: {sample:RuntimeSample;status:'operational'|'degraded';reasons:string[];details:unknown;deltas:Record<string,number>}|undefined;
 let lastAttemptAt:string|null=null;
 let samplingError:{at:string;code:string}|null=null;
 let failed=false;const history:RuntimeSample[]=[];
 const refresh=async()=>{
  if(running)return;running=true;lastAttemptAt=new Date(now()).toISOString();
  try{
   const sample=await collect();
   // Keep the point immediately before the 5-minute window to catch deltas.
   while(history.length>1&&history[1].at<=sample.at-300000)history.shift();
   if(!history.length)history.push({...sample,at:sample.at-1,rejected:0,timeouts:0,claim_lock_timeouts:0,scheduler_errors:0,planner_errors:0,partial:0,failed:0});
   const baseline=history[0];
   const health=runtimeStatus(sample,baseline);
   const deltas=Object.fromEntries(counterKeys.map(key=>[key,Math.max(0,sample[key]-baseline[key])]));
   last={sample,...health,details:structuredClone(details()),deltas};history.push(sample);if(history.length>32)history.shift();failed=false;samplingError=null;
  }catch(error){failed=true;samplingError={at:new Date(now()).toISOString(),code:samplingFailureCode(error)};}finally{running=false;}
 };
 const publicHealth=()=>({status:!last||failed||now()-last.sample.at>90000?'degraded':last.status,
  checked_at:last?new Date(last.sample.at).toISOString():null,
  reason:!last?'not_checked':failed?'probe_failed':now()-last.sample.at>90000?'probe_stale':last.status==='operational'?'healthy':'runtime_degraded'});
 return {refresh,publicHealth,privateHealth:()=>({...publicHealth(),window_seconds:300,process_local:true,
  process_started_at:processStartedAt,last_attempt_at:lastAttemptAt,sampling_error:samplingError,
  metrics_current:Boolean(last&&!failed&&now()-last.sample.at<=90000),metrics:last?structuredClone(last):null})};
}
