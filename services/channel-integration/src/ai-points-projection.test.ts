import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {aiPointsSchema} from './ai-points-schema.js';
import {aiPointsProjectionSchema} from './ai-points-projection.js';
import {aiPointFundingProjectionSchema} from './ai-point-funding-projection.js';

test('100k historical calls: bootstrap, incremental transitions, rollback, tenant isolation and rebuild agree',
 {skip:!process.env.AI_POINTS_TEST_DATABASE_URL},async()=>{
 const db=new pg.Client({connectionString:process.env.AI_POINTS_TEST_DATABASE_URL});
 await db.connect();
 const lot1=randomUUID(),lot2=randomUUID(),period='2026-09-01T00:00:00Z';
 try{
  await db.query(`CREATE SCHEMA point_projection_test;SET search_path TO point_projection_test,public;
   CREATE TABLE tenants(tenant_id text PRIMARY KEY);INSERT INTO tenants VALUES('target'),('other');
   CREATE TABLE ledger_entries(entry_id uuid PRIMARY KEY);`);
  await db.query(aiPointsSchema.replace(aiPointsProjectionSchema,'').replace(aiPointFundingProjectionSchema,''));
  await db.query(`INSERT INTO ai_usage_calls(tenant_id,request_key,feature,model,price_snapshot,period_start,status,
   reserved_micros,monthly_reserved_micros,charged_micros,monthly_charged_micros,credit_allocations)
   SELECT 'target','history-'||i,'copilot','synthetic','{}',$1,'succeeded',20,3,10,3,$2::jsonb FROM generate_series(1,100000) i`,
   [period,JSON.stringify([{entry_id:lot1,amount_minor:6},{entry_id:lot2,amount_minor:11}])]);
  await db.query(aiPointsProjectionSchema);
  const snapshot=async()=>({month:(await db.query('SELECT tenant_id,period_start,used_micros::text FROM ai_point_month_usage ORDER BY tenant_id,period_start')).rows,
   lots:(await db.query('SELECT tenant_id,entry_id,used_micros::text FROM ai_point_lot_usage WHERE used_micros>0 ORDER BY tenant_id,entry_id')).rows});
  const initial=await snapshot();assert.equal(initial.month[0].used_micros,'300000');
  assert.equal(initial.lots.find(r=>r.entry_id===lot1).used_micros,'600000');assert.equal(initial.lots.find(r=>r.entry_id===lot2).used_micros,'100000');
  const insert=async(tenant='target')=>(await db.query(`INSERT INTO ai_usage_calls(tenant_id,request_key,feature,model,price_snapshot,
   period_start,reserved_micros,monthly_reserved_micros,credit_allocations) VALUES($1,$2,'copilot','synthetic','{}',$3,20,3,$4) RETURNING call_id`,
   [tenant,randomUUID(),period,JSON.stringify([{entry_id:lot1,amount_minor:6},{entry_id:lot2,amount_minor:11}])])).rows[0].call_id;
  const success=await insert();
  await db.query("UPDATE ai_usage_calls SET status='succeeded',charged_micros=8,monthly_charged_micros=3 WHERE call_id=$1",[success]);
  const failed=await insert();await db.query("UPDATE ai_usage_calls SET status='failed' WHERE call_id=$1",[failed]);
  const expired=await insert();await db.query("UPDATE ai_usage_calls SET status='abandoned' WHERE call_id=$1",[expired]);
  const other=await insert('other');
  const before=await snapshot();
  await db.query('BEGIN');await insert();await db.query('ROLLBACK');assert.deepEqual(await snapshot(),before);
  await assert.rejects(db.query("UPDATE ai_usage_calls SET status='succeeded' WHERE call_id=$1",[success]),/immutable/);
  const zero=await insert();await db.query("UPDATE ai_usage_calls SET status='succeeded',charged_micros=0 WHERE call_id=$1",[zero]);
  assert.deepEqual(await snapshot(),before);
  // Reapplying migration does not double-count; full rebuild is independent of incremental deltas.
  await db.query(aiPointsProjectionSchema);assert.deepEqual(await snapshot(),before);
  await db.query('SELECT rebuild_ai_point_usage_projection()');assert.deepEqual(await snapshot(),before);
  assert.equal(before.month.find(r=>r.tenant_id==='target').used_micros,'300003');
  assert.equal(before.month.find(r=>r.tenant_id==='other').used_micros,'3');
  assert.equal(before.lots.find(r=>r.tenant_id==='target'&&r.entry_id===lot1).used_micros,'600005');
  await db.query(`INSERT INTO ai_usage_calls(tenant_id,request_key,feature,model,price_snapshot,period_start,reserved_micros,monthly_reserved_micros)
   VALUES('target','previous-month','copilot','synthetic','{}','2026-08-01T00:00:00Z',9,9)`);
  assert.equal((await db.query('SELECT used_micros FROM ai_point_month_usage WHERE tenant_id=$1 AND period_start=$2',['target',period])).rows[0].used_micros,'300003');
  const plan=(await db.query(`EXPLAIN (ANALYZE,FORMAT JSON) SELECT used_micros FROM ai_point_month_usage WHERE tenant_id='target' AND period_start=$1`,[period])).rows[0]['QUERY PLAN'];
  assert(!JSON.stringify(plan).includes('ai_usage_calls'));
  console.log(JSON.stringify({history_calls:100000,balance_plan_reads_history:false,projection_read_execution_ms:plan[0]['Execution Time'],rebuild_agrees:true}));
  await db.query("UPDATE ai_usage_calls SET status='abandoned' WHERE call_id=$1",[other]);
 }finally{await db.end();}
});
