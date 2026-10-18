import test from 'node:test';
import assert from 'node:assert/strict';
import {massHealthMetricsSql,massHealthReasons,massMonitorThresholds,monitorInteger,type MassHealthMetrics} from './campaign-monitor-core.js';
const empty:MassHealthMetrics={pending_batches:0,paused_batches:0,awaiting_receipt_batches:0,uncertain_batches:0,succeeded_batches_24h:0,unsuccessful_batches_24h:0,ready_batches:0,oldest_ready_seconds:0,oldest_receipt_seconds:0,failure_rate_percent:0};
test('monitor numbers reject invalid values and cap batch/rate configuration',()=>{
 for(const value of ['','NaN','Infinity','-1','0','1.5'])assert.equal(monitorInteger(value,100),100);
 assert.equal(monitorInteger('99999',100,1,200),200);
 assert.equal(massMonitorThresholds({MASS_CAMPAIGN_FAILURE_RATE_WARN_PERCENT:'200'}).failure_rate_percent,100);
 assert.equal(massMonitorThresholds({MASS_CAMPAIGN_RECEIPT_WARN_SECONDS:'NaN'}).receipt_seconds,900);
});
test('future, deferred and paused batches do not raise ready backlog alarms',()=>{
 assert.deepEqual(massHealthReasons({...empty,pending_batches:999,paused_batches:999}),[]);
 assert.deepEqual(massHealthReasons({...empty,awaiting_receipt_batches:1,oldest_receipt_seconds:899}),[]);
});
test('due backlog, stale receipts and uncertain outcomes are independent batch reasons',()=>{
 assert.equal(massHealthReasons({...empty,ready_batches:100,oldest_ready_seconds:900,awaiting_receipt_batches:1,oldest_receipt_seconds:900,uncertain_batches:1}).length,4);
 assert.equal(massHealthReasons({...empty,unsuccessful_batches_24h:9,failure_rate_percent:100}).length,0);
 assert.equal(massHealthReasons({...empty,unsuccessful_batches_24h:1,succeeded_batches_24h:9,failure_rate_percent:10}).length,1);
});
test('health SQL is aggregate only, filters time/state and uses tenant predicates only when scoped',()=>{
 const scoped=massHealthMetricsSql(true),global=massHealthMetricsSql(false);
 assert.equal((scoped.match(/tenant_id=\$1/g)??[]).length,2);
 assert.ok(!global.includes('$1')&&!scoped.includes('snapshot'));
 assert.ok(scoped.includes('b.available_at<=NOW()')&&scoped.includes('c.scheduled_at<=NOW()'));
 assert.ok(scoped.includes('COALESCE(b.locked_at,b.created_at)'));
 assert.ok(scoped.includes("updated_at>=NOW()-INTERVAL '24 hours'"));
});
