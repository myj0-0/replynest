const sampleKeys=['at','pending','oldest_seconds','expired_running','pool_waiting','rejected','timeouts','claim_lock_timeouts','scheduler_errors','planner_errors','partial','failed'];
const counterKeys=['rejected','timeouts','claim_lock_timeouts','scheduler_errors','planner_errors','partial','failed'];
const runtimeReasons=new Set(['database_pressure','planning_errors','queue_delay','expired_lease','claim_contention']);
const samplingCodes=new Set(['connection_pool_busy','sampling_lock_timeout','sampling_statement_timeout','sampling_permission_denied','sampling_schema_missing','database_connections_exhausted','database_restarting','database_unreachable','database_connection_reset','database_connection_timeout','sampling_failed']);
const errors=new Set(['automation_runtime_degraded','automation_not_checked','automation_sampling_failed','automation_probe_stale']);
export const diagnosticRetentionDays=90;
export const diagnosticLimit=2000;
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER?value:null;
const numbers=(value,keys)=>Object.fromEntries(keys.map(key=>[key,number(value?.[key])]));

export function sanitizeAutomationDiagnostic(value,observation,now=Date.now()){
 if(!value||!observation||value.status!==observation.status||value.reason!==observation.reason||iso(value.checked_at)!==observation.checked_at)return null;
 const checked=Date.parse(value.checked_at),fresh=Number.isFinite(checked)&&checked<=now+30000&&now-checked<=90000;
 const current=value.metrics_current===true&&fresh&&value.metrics?.sample?.at===checked&&
  !['probe_failed','probe_stale','not_checked'].includes(observation.reason);
 return {status:observation.status,reason:observation.reason,checked_at:observation.checked_at,
  process_started_at:iso(value.process_started_at),last_attempt_at:iso(value.last_attempt_at),metrics_current:current,
  sampling_error:value.sampling_error?{at:iso(value.sampling_error.at),code:samplingCodes.has(value.sampling_error.code)?value.sampling_error.code:'sampling_failed'}:null,
  // Never accept details, exceptions, tenant identifiers or unknown properties.
  metrics:value.metrics?{sample:{...numbers(value.metrics.sample,sampleKeys),pending_capped:value.metrics.sample?.pending_capped===true},
   reasons:Array.isArray(value.metrics.reasons)?[...new Set(value.metrics.reasons.filter(r=>runtimeReasons.has(r)))].slice(0,5):[],
   deltas:numbers(value.metrics.deltas,counterKeys)}:null};
}

export async function fetchAutomationDiagnostic(result,{fetchImpl=fetch,token,now=Date.now()}={}){
 if(result.ok||!result.automation_observation)return {snapshot:null,availability:'not_requested'};
 if(typeof token!=='string'||token.length<32||token.length>512)return {snapshot:null,availability:'not_configured'};
 try{
  // Fixed host/path, no redirects: the shared control secret never follows a redirect.
  const response=await fetchImpl('https://api.replynest.cn/health/automation?diagnostics=1',{
   redirect:'manual',headers:{authorization:`Bearer ${token}`,'user-agent':'ReplyNest-Blackbox/0.2'},signal:AbortSignal.timeout(3000)});
  if(response.status!==200)return {snapshot:null,availability:'unavailable'};
  const reader=response.body?.getReader();if(!reader)return {snapshot:null,availability:'unavailable'};
  let size=0;const chunks=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32768){await reader.cancel();return {snapshot:null,availability:'unavailable'};}chunks.push(value);}}
  finally{reader.releaseLock();}
  const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const snapshot=sanitizeAutomationDiagnostic(value,result.automation_observation,now);
  return {snapshot,availability:snapshot?'available':'sample_moved'};
 }catch{return {snapshot:null,availability:'unavailable'};}
}

export function recordAutomationDiagnostic(state,result,confirmedState,now=Date.now()){
 const prior=state.automation_diagnostic_cursor;
 const error=result.ok?null:errors.has(result.error)?result.error:'automation_network_or_http_failure';
 const snapshot=result.automation_diagnostic?.snapshot??null;
 const reason=snapshot?.sampling_error?.code||(snapshot?.metrics_current&&snapshot?.metrics?.reasons?.join(','))||error;
 const signature=JSON.stringify([result.ok,confirmedState,reason,snapshot?.process_started_at??null]);
 state.automation_diagnostics=(state.automation_diagnostics??[]).filter(r=>Number.isFinite(r.at)&&r.at>=now-diagnosticRetentionDays*86400000).slice(-diagnosticLimit);
 if(signature===prior?.signature)return;
 // First healthy startup is not an incident. After a failure, keep the recovery.
 if(!prior&&result.ok){state.automation_diagnostic_cursor={signature,ok:true,confirmedState};return;}
 if(prior?.ok&&result.ok&&!(prior.confirmedState==='down'&&confirmedState==='up')){state.automation_diagnostic_cursor={signature,ok:true,confirmedState};return;}
 const kind=result.ok?(confirmedState==='down'?'recovering':'recovered'):confirmedState==='down'?'confirmed':'degraded';
 const availability=result.automation_diagnostic?.availability??'not_requested';
 state.automation_diagnostics.push({at:now,kind,error,confirmed:confirmedState==='down',
  snapshot:snapshot?structuredClone(snapshot):null,diagnostic_availability:availability});
 state.automation_diagnostics=state.automation_diagnostics.slice(-diagnosticLimit);
 state.automation_diagnostic_cursor={signature,ok:result.ok,confirmedState};
}

export function automationDiagnosticPage(state,page=1,now=Date.now()){
 const rows=(state.automation_diagnostics??[]).filter(r=>Number.isFinite(r.at)&&r.at>=now-diagnosticRetentionDays*86400000).slice(-diagnosticLimit).reverse();
 const offset=(page-1)*20;
 return {records:rows.slice(offset,offset+20),page,page_size:20,has_more:rows.length>offset+20,
  retention_days:diagnosticRetentionDays,max_records:diagnosticLimit};
}
