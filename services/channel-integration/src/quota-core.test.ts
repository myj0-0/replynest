import test from"node:test";import assert from"node:assert/strict";
import{crossedQuotaThresholds,quotaPercent}from"./quota-core.js";
test("quota warning emits only the highest crossed threshold",()=>{assert.deepEqual(crossedQuotaThresholds(79,100),[]);assert.deepEqual(crossedQuotaThresholds(80,100),[80]);assert.deepEqual(crossedQuotaThresholds(100,100),[100]);assert.equal(quotaPercent(125,100),125)});
test("unlimited and unused zero quotas do not warn",()=>{assert.deepEqual(crossedQuotaThresholds(999,null),[]);assert.deepEqual(crossedQuotaThresholds(0,0),[]);assert.deepEqual(crossedQuotaThresholds(1,0),[100])});
