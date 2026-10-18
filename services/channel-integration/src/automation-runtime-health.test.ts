import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntimeMonitor,runtimeStatus,recordPlanOutcome,runtimeCounters,samplingFailureCode,type RuntimeSample} from './automation-runtime-health.js';
import {automationDiagnosticsAuthorized,handleAutomationHealth} from './automation-diagnostics-auth.js';
import {createServer} from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
const sample=(at=1000000):RuntimeSample=>({at,pending:0,pending_capped:false,oldest_seconds:0,expired_running:0,pool_waiting:0,rejected:0,timeouts:0,claim_lock_timeouts:0,scheduler_errors:0,planner_errors:0,partial:0,failed:0});
test('runtime thresholds, counter deltas and recovery',()=>{
 const base=sample();assert.equal(runtimeStatus(base,base).status,'operational');
 for(const change of [{oldest_seconds:120},{expired_running:1},{pool_waiting:20},{rejected:1},{timeouts:1},{claim_lock_timeouts:1},{scheduler_errors:1},{planner_errors:1},{partial:1},{failed:1}])assert.equal(runtimeStatus({...base,...change},base).status,'degraded');
 assert.equal(runtimeStatus({...base,rejected:3},{...base,rejected:3}).status,'operational');
});
test('public cache is single-flight, stale-safe and excludes private metrics',async()=>{
 let at=1000000,calls=0,fail=false;
 const monitor=createRuntimeMonitor(async()=>{calls++;await Promise.resolve();if(fail)throw Error('sensitive backend failure');return sample(at);},()=>({private:'never_public'}),()=>at);
 assert.equal(monitor.publicHealth().reason,'not_checked');
 await Promise.all([monitor.refresh(),monitor.refresh()]);assert.equal(calls,1);
 assert.equal(monitor.publicHealth().status,'operational');
 assert.equal(JSON.stringify(monitor.publicHealth()).includes('never_public'),false);
 assert.deepEqual(Object.keys(monitor.publicHealth()).sort(),['checked_at','reason','status']);
 for(let i=0;i<100;i++)monitor.publicHealth();assert.equal(calls,1);
 at+=90001;assert.equal(monitor.publicHealth().reason,'probe_stale');
 fail=true;await monitor.refresh();assert.equal(monitor.publicHealth().reason,'probe_failed');
 assert.equal(JSON.stringify(monitor.privateHealth()).includes('sensitive backend'),false);
 fail=false;await monitor.refresh();assert.equal(monitor.publicHealth().status,'operational');
});
test('window ages errors out without clearing lifetime counters',async()=>{
 let at=1000000,count=1;
 const monitor=createRuntimeMonitor(async()=>({...sample(at),rejected:count}),()=>({}),()=>at);
 await monitor.refresh();assert.equal(monitor.publicHealth().status,'degraded');
 for(let i=0;i<12;i++){at+=30000;await monitor.refresh();if(i<8)assert.equal(monitor.publicHealth().status,'degraded');}
 assert.equal(monitor.publicHealth().status,'operational');count++;at+=30000;await monitor.refresh();assert.equal(monitor.publicHealth().status,'degraded');
});
test('outcome reasons are whitelisted, not raw exception strings',()=>{
 const before=runtimeCounters.reasons.other;recordPlanOutcome('failed','secret user data',false);
 assert.equal(runtimeCounters.reasons.other,before+1);assert.equal(JSON.stringify(runtimeCounters).includes('secret'),false);
});

test('sampling failure snapshots retain old sample but explicitly mark it not current',async()=>{
 let at=1000000,fail=false;
 const monitor=createRuntimeMonitor(async()=>{if(fail)throw Object.assign(Error('secret SQL / customer text'),{code:'55P03'});return sample(at);},()=>({}),()=>at);
 await monitor.refresh();fail=true;at+=30000;await monitor.refresh();
 const health=monitor.privateHealth();assert.equal(health.metrics_current,false);
 assert.equal(health.sampling_error?.code,'sampling_lock_timeout');
 assert.equal(health.metrics?.sample.at,1000000);assert.equal(health.last_attempt_at,new Date(at).toISOString());
 assert.equal(JSON.stringify(health).includes('secret'),false);
 fail=false;at+=30000;await monitor.refresh();assert.equal(monitor.privateHealth().sampling_error,null);
 assert.equal(monitor.privateHealth().metrics_current,true);at+=90001;assert.equal(monitor.privateHealth().metrics_current,false);
});

test('private diagnostics carry window deltas and cannot mutate cached metrics',async()=>{
 let at=1000000,rejected=0;
 const monitor=createRuntimeMonitor(async()=>({...sample(at),rejected}),()=>({}),()=>at);
 await monitor.refresh();at+=30000;rejected=3;await monitor.refresh();
 assert.equal(monitor.privateHealth().metrics?.deltas.rejected,3);
 const view=monitor.privateHealth();view.metrics!.sample.pending=900;
 assert.equal(monitor.privateHealth().metrics?.sample.pending,0);
 assert.deepEqual(Object.keys(monitor.publicHealth()).sort(),['checked_at','reason','status']);
});

test('sampling errors and diagnostic authentication use bounded allowlists',()=>{
 for(const [code,expected] of [['42501','sampling_permission_denied'],['57014','sampling_statement_timeout'],['database_busy','connection_pool_busy']])assert.equal(samplingFailureCode({code}),expected);
 assert.equal(samplingFailureCode({code:'secret-token'}),'sampling_failed');
 for(const code of ['constructor','__proto__','toString'])assert.equal(samplingFailureCode({code}),'sampling_failed');
 const key='k'.repeat(40);assert.equal(automationDiagnosticsAuthorized(`Bearer ${key}`,key),true);
 for(const value of [undefined,['Bearer '+key],'Bearer wrong',`Bearer ${key} `,'x'.repeat(1000)])assert.equal(automationDiagnosticsAuthorized(value,key),false);
 assert.equal(automationDiagnosticsAuthorized('Bearer short','short'),false);
});

test('actual health handler HTTP keeps diagnostics private and serves only cached metrics',async()=>{
 let calls=0;const key='test-control-token-local-only-'.repeat(2);
 const monitor=createRuntimeMonitor(async()=>{calls++;return sample(Date.now());},()=>({}),Date.now);await monitor.refresh();
 const server=createServer((request,response)=>{if(!handleAutomationHealth(request,response,new URL(request.url!,'http://localhost'),monitor,key)){response.writeHead(404);response.end();}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 try{
  const publicResponse=await fetch(base+'/health/automation'),publicValue=await publicResponse.json();assert.equal(publicResponse.status,200);
  assert.deepEqual(Object.keys(publicValue).sort(),['checked_at','reason','status']);
  for(const headers of [{},{authorization:'Bearer invalid'}] as Record<string,string>[]){
   const denied=await fetch(base+'/health/automation?diagnostics=1',{headers});assert.equal(denied.status,404);assert.equal((await denied.text()).includes('pool_waiting'),false);
  }
  const privateResponse=await fetch(base+'/health/automation?diagnostics=1',{headers:{authorization:'Bearer '+key}});
  assert.equal(privateResponse.status,200);assert.equal(privateResponse.headers.get('cache-control'),'no-store');
  const snapshot=await privateResponse.json();assert.equal(snapshot.metrics_current,true);assert.equal(snapshot.metrics.sample.pool_waiting,0);
  assert.equal((await fetch(base+'/health/automation?diagnostics=1',{method:'POST',headers:{authorization:'Bearer '+key}})).status,404);
  const ordinary=await fetch(base+'/health/automation',{headers:{authorization:'Bearer '+key}});assert.deepEqual(Object.keys(await ordinary.json()).sort(),['checked_at','reason','status']);
  assert.equal(calls,1);assert.equal(JSON.stringify(snapshot).includes(key),false);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
