import test from 'node:test';
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {tenantMassCampaignMetrics,tenantMassMetricsSql} from './mass-campaign-metrics.js';
test('mass metrics reject empty tenant without querying and use separate batch windows',async()=>{
 let calls=0;
 const db={query:async(_sql:string,args:unknown[])=>{calls++;assert.deepEqual(args,['甲企业']);return {rows:[{pending_batches:2}]};}} as unknown as Pick<PoolClient,'query'>;
 await assert.rejects(()=>tenantMassCampaignMetrics(db,' '),/tenant_required/);assert.equal(calls,0);
 assert.equal((await tenantMassCampaignMetrics(db,'甲企业')).pending_batches,2);
 assert.ok(tenantMassMetricsSql.includes('b.tenant_id=$1')&&tenantMassMetricsSql.includes('WHERE tenant_id=$1'));
 assert.ok(tenantMassMetricsSql.includes("c.status IN('scheduled','running')"));
 assert.ok(!tenantMassMetricsSql.includes('snapshot'));
});
