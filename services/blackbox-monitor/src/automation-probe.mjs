const publicReasons=new Set(['healthy','not_checked','probe_failed','probe_stale','runtime_degraded']);
// Public endpoint exposes only a status and bounded freshness metadata.
export function automationProbeResult(value,now=Date.now()){
 const checked=Date.parse(value?.checked_at);
 const fresh=Number.isFinite(checked)&&checked<=now+30000&&now-checked<=90000;
 const reason=publicReasons.has(value?.reason)?value.reason:'runtime_degraded';
 const failure=({not_checked:'automation_not_checked',probe_failed:'automation_sampling_failed',probe_stale:'automation_probe_stale'})[reason];
 const error=value?.status!=='operational'&&failure?failure:!fresh?'automation_probe_stale':value?.status==='operational'?undefined:'automation_runtime_degraded';
 return {ok:fresh&&value?.status==='operational',latency_ms:0,
  error,automation_observation:{status:value?.status==='operational'?'operational':'degraded',reason,
   checked_at:Number.isFinite(checked)?new Date(checked).toISOString():null}};
}
