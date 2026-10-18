import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchAutomationDiagnostic,sanitizeAutomationDiagnostic,recordAutomationDiagnostic,automationDiagnosticPage,diagnosticLimit} from './automation-diagnostics.mjs';
import {automationProbeResult} from './automation-probe.mjs';
const now=1791640000000,at=new Date(now).toISOString();
const observation={status:'degraded',reason:'runtime_degraded',checked_at:at};
const payload={...observation,process_started_at:at,last_attempt_at:at,metrics_current:true,sampling_error:null,
 metrics:{sample:{at:now,pending:2,pool_waiting:25,rejected:9,pending_capped:false},reasons:['database_pressure'],deltas:{rejected:3}}};

test('diagnostic snapshots whitelist only numeric metrics and controlled reason codes',()=>{
 const value=structuredClone(payload);value.token='secret';value.metrics.sample.customer='sensitive';value.metrics.sample.pool_waiting='password';
 value.metrics.reasons.push('sql password');value.metrics.details={tenant:'secret'};
 const safe=sanitizeAutomationDiagnostic(value,observation,now);
 assert.equal(safe.metrics.sample.pool_waiting,null);assert.equal(safe.metrics.deltas.rejected,3);
 assert.deepEqual(safe.metrics.reasons,['database_pressure']);assert.equal(/secret|sensitive|password/.test(JSON.stringify(safe)),false);
});

test('snapshot must match the original public sample, failed/old samples cannot claim currency',()=>{
 assert.equal(sanitizeAutomationDiagnostic({...payload,checked_at:new Date(now+1).toISOString()},observation,now),null);
 assert.equal(sanitizeAutomationDiagnostic({...payload,status:'operational'},observation,now),null);
 assert.equal(sanitizeAutomationDiagnostic({...payload,reason:'healthy'},observation,now),null);
 assert.equal(sanitizeAutomationDiagnostic(payload,observation,now+90001).metrics_current,false);
 assert.equal(sanitizeAutomationDiagnostic({...payload,metrics:{...payload.metrics,sample:{at:now-1}}},observation,now).metrics_current,false);
 const failed={...payload,reason:'probe_failed',metrics_current:false,sampling_error:{at,code:'SQL password'}};
 const safe=sanitizeAutomationDiagnostic(failed,{...observation,reason:'probe_failed'},now);
 assert.equal(safe.metrics_current,false);assert.equal(safe.sampling_error.code,'sampling_failed');
});

test('protected fetch uses fixed endpoint, no redirects, no credentials persisted',async()=>{
 let calls=0;
 const result=automationProbeResult(payload,now);
 const found=await fetchAutomationDiagnostic(result,{now,token:'t'.repeat(40),fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://api.replynest.cn/health/automation?diagnostics=1');assert.equal(options.redirect,'manual');
  assert.equal(options.headers.authorization,'Bearer '+'t'.repeat(40));return Response.json(payload);
 }});
 assert.equal(calls,1);assert.equal(found.availability,'available');assert.equal(JSON.stringify(found).includes('t'.repeat(40)),false);
});

test('healthy/anonymous checks do not fetch private metrics',async()=>{
 const fail=()=>{throw Error('must not call')};
 assert.equal((await fetchAutomationDiagnostic({ok:true},{fetchImpl:fail})).availability,'not_requested');
 assert.equal((await fetchAutomationDiagnostic({ok:false},{fetchImpl:fail})).availability,'not_requested');
 assert.equal((await fetchAutomationDiagnostic({ok:false,automation_observation:observation},{fetchImpl:fail})).availability,'not_configured');
});

test('diagnostic failure, moved samples, oversize and invalid responses never change health',async()=>{
 const result=automationProbeResult(payload,now);
 for(const response of [new Response('',{status:302}),new Response('',{status:404}),new Response('not JSON'),new Response('x'.repeat(32769))]){
  assert.equal((await fetchAutomationDiagnostic(result,{now,token:'t'.repeat(40),fetchImpl:async()=>response})).availability,'unavailable');
  assert.equal(result.ok,false);
 }
 assert.equal((await fetchAutomationDiagnostic(result,{now,token:'t'.repeat(40),fetchImpl:async()=>{throw Error('private auth token')}})).availability,'unavailable');
 assert.equal((await fetchAutomationDiagnostic(result,{now,token:'t'.repeat(40),fetchImpl:async()=>Response.json({...payload,checked_at:new Date(now+1).toISOString()})})).availability,'sample_moved');
});

test('persisted history records first miss, confirmation, reason change and recovery without per-poll duplication',()=>{
 const state={},bad={...automationProbeResult(payload,now),automation_diagnostic:{snapshot:sanitizeAutomationDiagnostic(payload,observation,now),availability:'available'}};
 recordAutomationDiagnostic(state,{ok:true},'up',now);assert.equal(state.automation_diagnostics.length,0);
 recordAutomationDiagnostic(state,bad,'up',now+1);recordAutomationDiagnostic(state,bad,'up',now+2);
 assert.equal(state.automation_diagnostics.length,1);
 recordAutomationDiagnostic(state,bad,'down',now+3);assert.equal(state.automation_diagnostics[1].kind,'confirmed');
 const persisted=JSON.parse(JSON.stringify(state));recordAutomationDiagnostic(persisted,bad,'down',now+4);assert.equal(persisted.automation_diagnostics.length,2);
 bad.automation_diagnostic.snapshot.sampling_error={code:'sampling_lock_timeout'};
 assert.equal(persisted.automation_diagnostics[0].snapshot.sampling_error,null);
 recordAutomationDiagnostic(persisted,bad,'down',now+5);assert.equal(persisted.automation_diagnostics.length,3);
 recordAutomationDiagnostic(persisted,{ok:true},'down',now+6);recordAutomationDiagnostic(persisted,{ok:true},'up',now+7);
 assert.equal(persisted.automation_diagnostics.length,5);assert.equal(persisted.automation_diagnostics[3].kind,'recovering');assert.equal(persisted.automation_diagnostics[4].kind,'recovered');
});

test('diagnostic retention and pagination survive restarts; runtime counters and daily availability are untouched',()=>{
 const state={availability:{automation:{day:{up:5,total:6}}},events:[{kind:'old incident'}]};
 state.automation_diagnostics=Array.from({length:diagnosticLimit+5},(_,i)=>({at:now+i,kind:'degraded',error:'automation_network_or_http_failure'}));
 state.automation_diagnostics.unshift({at:now-91*86400000});
 recordAutomationDiagnostic(state,{ok:true},'up',now);
 assert.equal(state.automation_diagnostics.length,diagnosticLimit);
 const loaded=JSON.parse(JSON.stringify(state));const first=automationDiagnosticPage(loaded,1,now),last=automationDiagnosticPage(loaded,100,now);
 assert.equal(first.records.length,20);assert.equal(first.has_more,true);assert.equal(last.records.length,20);assert.equal(last.has_more,false);
 assert.equal(first.records.some(r=>last.records.some(l=>r.at===l.at)),false);
 assert.deepEqual(state.availability,{automation:{day:{up:5,total:6}}});assert.equal(state.events.length,1);
});

test('public probe distinguishes sampling, freshness and startup failures without forwarding private contents',()=>{
 assert.equal(automationProbeResult({status:'degraded',checked_at:null,reason:'not_checked'},now).error,'automation_not_checked');
 for(const [reason,error]of [['probe_failed','automation_sampling_failed'],['probe_stale','automation_probe_stale'],['not_checked','automation_not_checked'],['runtime_degraded','automation_runtime_degraded']]){
  assert.equal(automationProbeResult({...payload,reason},now).error,error);
 }
 assert.equal(JSON.stringify(automationProbeResult({...payload,reason:'password'},now)).includes('password'),false);
});
