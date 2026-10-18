import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForFixtureDatabaseDue,waitForFixtureRecordedIngressClock} from './reception-fixture-sql-guards.js';
const job='11111111-1111-4111-8111-111111111111';
const row=(ready:boolean,remaining_ms:number)=>({wait_state:'waiting',job_state:'processing',ready,remaining_ms});

test('fixture lock observation selects the exact formal runtime rather than silently counting a missing legacy role',async()=>{
 const previous=process.env.RECEPTION_FORMAL_RUNTIME;
 try{
  delete process.env.RECEPTION_FORMAL_RUNTIME;
  const legacy=await import(new URL('./reception-fixture-sql-guards.js?legacy-role',import.meta.url).href);
  assert.ok(legacy.receptionFixtureSqlGuards.includes("a.usename='history_runtime'"));
  process.env.RECEPTION_FORMAL_RUNTIME='isolated-formal-reception';
  const formal=await import(new URL('./reception-fixture-sql-guards.js?formal-role',import.meta.url).href);
  assert.ok(formal.receptionFixtureSqlGuards.includes("a.usename='replynest_runtime'"));
  assert.ok(!formal.receptionFixtureSqlGuards.includes("a.usename='history_runtime'"));
  process.env.RECEPTION_FORMAL_RUNTIME='arbitrary';
  await assert.rejects(()=>import(new URL('./reception-fixture-sql-guards.js?invalid-role',import.meta.url).href),/fixed_formal_fixture_runtime/);
 }finally{if(previous===undefined)delete process.env.RECEPTION_FORMAL_RUNTIME;else process.env.RECEPTION_FORMAL_RUNTIME=previous;}
});
test('fixture waits on the same PG row, not Node wall time, without writing or dispatching',async t=>{
 t.mock.method(Date,'now',()=>{throw Error('Node wall clock must not decide SQL due status');});
 const rows=[row(false,1),row(false,-0.1),row(true,-1)],queries:string[]=[];
 await waitForFixtureDatabaseDue({query:async(sql,values)=>{queries.push(sql);assert.deepEqual(values,[job]);return {rows:[rows.shift()]};}},job);
 assert.equal(queries.length,3);assert.ok(queries.every(sql=>sql.trim().startsWith('SELECT')&&sql.includes('clock_timestamp()')));
});
test('fixture refuses missing, changed, malformed or excessive waiting record',async()=>{
 for(const value of [undefined,{...row(true,-1),wait_state:'finished'},{...row(true,-1),job_state:'accepted'},
  row(false,NaN),row(false,30001),{...row(true,-1),ready:1}])
  await assert.rejects(()=>waitForFixtureDatabaseDue({query:async()=>({rows:[value]})},job),/not_observable/);
});
test('fixture observation itself has a monotonic deadline without moving SQL due time',async t=>{
 let calls=0;t.mock.method(performance,'now',()=>calls++===0?0:40000);
 await assert.rejects(()=>waitForFixtureDatabaseDue({query:async()=>({rows:[row(false,500)]})},job),/observation_deadline/);
});
test('fixture rejects non-exact job IDs before accessing DB',async()=>{
 for(const value of ['',job+';SELECT 1','other-customer'])
  await assert.rejects(()=>waitForFixtureDatabaseDue({query:async()=>{throw Error('unexpected DB');}},value),/fixed_fixture_job/);
});
test('expiry observation selects only the fixed expiry field; arbitrary SQL selector is rejected',async()=>{
 await waitForFixtureDatabaseDue({query:async(sql,values)=>{assert.deepEqual(values,[job]);assert.ok(sql.includes('w.expires_at')&&!sql.includes('w.due_at'));return {rows:[row(true,-1)]};}},job,'expires');
 await assert.rejects(()=>waitForFixtureDatabaseDue({query:async()=>{throw Error('unexpected DB');}},job,'arbitrary' as any),/fixed_fixture_deadline/);
});
test('ingress observation waits for stored PG event time after rollback without intake or writes',async t=>{
 t.mock.method(Date,'now',()=>{throw Error('Node wall time not authoritative');});
 const rows=[{ready:false,remaining_ms:1},{ready:true,remaining_ms:-1}];let calls=0;
 await waitForFixtureRecordedIngressClock({query:async(sql,values)=>{calls++;assert.deepEqual(values,['wx6666666666666666','123']);
  assert.ok(sql.trim().startsWith('SELECT')&&sql.includes('source_occurred_at')&&sql.includes('d.created_at'));return {rows:[rows.shift()]};}},'wx6666666666666666','123');
 assert.equal(calls,2);
});
test('ingress rejects malformed scope and non-observable clock without fabricating acceptance',async()=>{
 for(const value of [undefined,{ready:1,remaining_ms:0},{ready:false,remaining_ms:NaN},{ready:false,remaining_ms:3001}])
  await assert.rejects(()=>waitForFixtureRecordedIngressClock({query:async()=>({rows:[value]})},'wx6666666666666666','123'),/not_observable/);
 for(const [app,id] of [['other','123'],['wx6666666666666666','0'],['wx6666666666666666','1;SELECT']])
  await assert.rejects(()=>waitForFixtureRecordedIngressClock({query:async()=>{throw Error('unexpected DB');}},app,id),/fixed_fixture_ingress/);
});
test('ingress clock observation has a monotonic deadline',async t=>{
 let calls=0;t.mock.method(performance,'now',()=>calls++===0?0:11000);
 await assert.rejects(()=>waitForFixtureRecordedIngressClock({query:async()=>({rows:[{ready:false,remaining_ms:500}]})},'wx6666666666666666','123'),/clock_deadline/);
});
