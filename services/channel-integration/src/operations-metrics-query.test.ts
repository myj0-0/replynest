import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {OPERATIONS_COUNTS_SQL} from './operations-metrics-query.js';

// Independent pre-optimization oracle. Keep the old predicates here so a change
// in the production query cannot silently redefine the expected business counts.
const legacy=`SELECT
 (SELECT COUNT(DISTINCT ci.customer_id) FROM outbound_deliveries od JOIN channel_identities ci ON ci.tenant_id=od.tenant_id AND ci.chatwoot_conversation_id=od.chatwoot_conversation_id WHERE od.tenant_id=$1 AND od.created_at >= $2 AND od.created_at < $3) AS served_customers,
 (SELECT COUNT(*) FROM customers WHERE tenant_id=$1 AND first_seen_at >= $2 AND first_seen_at < $3) AS new_customers,
 (SELECT COUNT(*) FROM customers WHERE tenant_id=$1 AND first_seen_at >= $4 AND first_seen_at < $2) AS previous_new_customers,
 (SELECT COUNT(*) FROM ai_recommendations WHERE tenant_id=$1 AND generated_at >= $5 AND status IN ('generated','inserted','accepted','edited','rejected','expired_before_send')) AS ai_displayed,
 (SELECT COUNT(*) FROM ai_recommendations WHERE tenant_id=$1 AND generated_at >= $5 AND status IN ('accepted','edited')) AS ai_accepted,
 (SELECT COUNT(*) FROM outbound_deliveries WHERE tenant_id=$1 AND status='failed') AS outbound_failures,
 (SELECT COUNT(*) FROM temporary_policies WHERE tenant_id=$1 AND status IN ('approved','active') AND valid_until>NOW() AND valid_until<=NOW()+INTERVAL '3 days') AS expiring_policies,
 (SELECT COUNT(*) FROM knowledge_documents WHERE tenant_id=$1 AND status='active' AND valid_until>NOW() AND valid_until<=NOW()+INTERVAL '3 days') AS expiring_documents,
 (SELECT COUNT(*) FROM knowledge_jobs WHERE tenant_id=$1 AND status IN ('failed','dead')) AS failed_knowledge_jobs,
 (SELECT COUNT(*) FROM knowledge_documents WHERE tenant_id=$1 AND status='active' AND ingestion_status='ready') AS active_knowledge_documents,
 (SELECT COUNT(*) FROM tenant_memberships WHERE tenant_id=$1 AND status='active') AS active_members,
 (SELECT COUNT(*) FROM gateway_events WHERE tenant_id=$1 AND status='processed') AS processed_inbound_events,
 (SELECT COUNT(*) FROM gateway_events WHERE tenant_id=$1 AND status IN ('queued','processing','retry_pending')) AS pending_inbound_events,
 (SELECT COUNT(*) FROM gateway_events WHERE tenant_id=$1 AND status='dead') AS dead_inbound_events,
 (SELECT COUNT(*) FROM channel_connections WHERE tenant_id=$1 AND status='ready' AND COALESCE(configuration->>'mode','')<>'synthetic') AS ready_channels`;

test('rollups retain tenant predicates and never cache statistics',()=>{
 for(const table of ['customers','ai_recommendations','knowledge_documents','gateway_events']){
  assert.equal([...OPERATIONS_COUNTS_SQL.matchAll(new RegExp('FROM '+table+' WHERE tenant_id=\\$1','g'))].length,1);
 }
 assert.match(OPERATIONS_COUNTS_SQL,/COUNT\(DISTINCT ci.customer_id\)/);
 assert.match(OPERATIONS_COUNTS_SQL,/ci.tenant_id=od.tenant_id/);
});

test('isolated PostgreSQL: old and new counts agree, repeated scans are reduced',{
 skip:process.env.OPERATIONS_METRICS_DB_TEST!=='true'
},async t=>{
 assert.equal(process.env.PGHOST,'127.0.0.1');
 assert.match(process.env.PGDATABASE??'',/^replynest_metrics_test(?:_[a-z0-9]+)?$/);
 const db=new pg.Client(); await db.connect();
 try{
  await db.query('BEGIN');
  for(const sql of [
   'customers(tenant_id text,first_seen_at timestamptz)',
   'ai_recommendations(tenant_id text,generated_at timestamptz,status text)',
   'knowledge_documents(tenant_id text,status text,valid_until timestamptz,ingestion_status text)',
   'gateway_events(tenant_id text,status text)',
   'outbound_deliveries(tenant_id text,chatwoot_conversation_id int,created_at timestamptz,status text)',
   'channel_identities(tenant_id text,chatwoot_conversation_id int,customer_id text)',
   'temporary_policies(tenant_id text,status text,valid_until timestamptz)',
   'knowledge_jobs(tenant_id text,status text)',
   'tenant_memberships(tenant_id text,status text)',
   'channel_connections(tenant_id text,status text,configuration jsonb)'
  ])await db.query('CREATE TEMP TABLE '+sql+' ON COMMIT DROP');
  const dates=(await db.query(`SELECT date_trunc('day',NOW()) AS start,date_trunc('day',NOW())+INTERVAL '1 day' AS finish,
   date_trunc('day',NOW())-INTERVAL '1 day' AS previous,date_trunc('week',NOW()) AS week`)).rows[0];
  const args=(tenant:string)=>[tenant,dates.start,dates.finish,dates.previous,dates.week];
  const compare=async(tenant:string)=>{
   const before=(await db.query(legacy,args(tenant))).rows[0],after=(await db.query(OPERATIONS_COUNTS_SQL,args(tenant))).rows[0];
   assert.deepEqual(after,before);assert.equal(Object.keys(after).length,15);return after;
  };
  await t.test('empty tenant is one complete zero-valued row',async()=>{
   assert.ok(Object.values(await compare('empty')).every(v=>v==='0'));
  });
  await db.query(`INSERT INTO customers SELECT 'a',x FROM unnest(ARRAY[
   $1::timestamptz-INTERVAL '1 microsecond',$1,$2::timestamptz-INTERVAL '1 microsecond',$2,$3::timestamptz-INTERVAL '1 microsecond',$3,NULL]) x`,[dates.previous,dates.start,dates.finish]);
  await db.query(`INSERT INTO ai_recommendations SELECT 'a',$1,x FROM unnest(ARRAY['generated','inserted','accepted','edited','rejected','expired_before_send','unrelated',NULL]) x;
   `,[dates.week]);
  await db.query(`INSERT INTO knowledge_documents SELECT 'a',s,v,i FROM unnest(ARRAY['active','disabled']) s
   CROSS JOIN unnest(ARRAY[NOW(),NOW()+INTERVAL '1 microsecond',NOW()+INTERVAL '3 days',NOW()+INTERVAL '3 days 1 microsecond',NULL]) v
   CROSS JOIN unnest(ARRAY['ready','pending',NULL]) i`);
  await db.query(`INSERT INTO gateway_events SELECT 'a',x FROM unnest(ARRAY['processed','processed','queued','processing','retry_pending','dead','ignored',NULL]) x`);
  await db.query(`INSERT INTO outbound_deliveries VALUES ('a',1,$1,'sent'),('a',1,$1,'sent'),('a',2,$2,'failed');
   `,[dates.start,dates.finish]);
  await db.query(`INSERT INTO channel_identities VALUES ('a',1,'same-customer'),('a',1,'same-customer'),('b',1,'other-customer')`);
  await db.query(`INSERT INTO temporary_policies SELECT 'a',s,v FROM unnest(ARRAY['approved','active','draft']) s
   CROSS JOIN unnest(ARRAY[NOW(),NOW()+INTERVAL '3 days',NOW()+INTERVAL '3 days 1 microsecond',NULL]) v`);
  await db.query(`INSERT INTO knowledge_jobs VALUES ('a','failed'),('a','dead'),('a','ready');
   INSERT INTO tenant_memberships VALUES ('a','active'),('a','disabled');
   INSERT INTO channel_connections VALUES ('a','ready',NULL),('a','ready','{}'),('a','ready','{"mode":"synthetic"}'),('a','disabled','{}')`);
  await t.test('inclusive starts, exclusive day end, expiry, NULL, duplicates and statuses',async()=>{
   const counts=await compare('a');
   assert.equal(counts.new_customers,'2');assert.equal(counts.previous_new_customers,'2');
   assert.equal(counts.served_customers,'1');assert.equal(counts.ai_displayed,'6');assert.equal(counts.ai_accepted,'2');
   assert.equal(counts.expiring_documents,'6');assert.equal(counts.active_knowledge_documents,'5');
   assert.equal(counts.expiring_policies,'2');assert.equal(counts.ready_channels,'2');
  });
  // Larger deterministic mixed-tenant fixture, including dates outside each window.
  await db.query(`INSERT INTO customers SELECT CASE WHEN n%3=0 THEN 'b' ELSE 'a' END,NOW()-n*INTERVAL '10 minutes' FROM generate_series(1,10000) n;
   INSERT INTO ai_recommendations SELECT CASE WHEN n%3=0 THEN 'b' ELSE 'a' END,NOW()-n*INTERVAL '10 minutes',(ARRAY['accepted','edited','generated','rejected','unrelated'])[n%5+1] FROM generate_series(1,10000) n;
   INSERT INTO knowledge_documents SELECT CASE WHEN n%3=0 THEN 'b' ELSE 'a' END,CASE WHEN n%7=0 THEN 'disabled' ELSE 'active' END,NOW()+n*INTERVAL '10 minutes',CASE WHEN n%2=0 THEN 'ready' ELSE 'pending' END FROM generate_series(1,10000) n;
   INSERT INTO gateway_events SELECT CASE WHEN n%3=0 THEN 'b' ELSE 'a' END,(ARRAY['processed','queued','processing','retry_pending','dead','ignored'])[n%6+1] FROM generate_series(1,10000) n`);
  for(const tenant of ['a','b','missing'])await t.test('40k-row fixture preserves exact counts for '+tenant,async()=>{await compare(tenant);});
  await t.test('query plan reads each repeated source once instead of nine times',async()=>{
   const counts=async(sql:string)=>{
    const plan=(await db.query('EXPLAIN (ANALYZE,FORMAT JSON) '+sql,args('a'))).rows[0]['QUERY PLAN'][0];
    let scans=0;const visit=(n:any)=>{if(['customers','ai_recommendations','knowledge_documents','gateway_events'].includes(n['Relation Name']))scans++;for(const p of n.Plans??[])visit(p);};visit(plan.Plan);
    return {scans,milliseconds:plan['Execution Time']};
   };
   const before=await counts(legacy),after=await counts(OPERATIONS_COUNTS_SQL);
   assert.equal(before.scans,9);assert.equal(after.scans,4);t.diagnostic(JSON.stringify({synthetic_benchmark:{before,after}}));
  });
 }finally{await db.query('ROLLBACK');await db.end();}
});
