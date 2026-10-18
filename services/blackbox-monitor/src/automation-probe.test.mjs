import test from 'node:test';
import assert from 'node:assert/strict';
import {automationProbeResult} from './automation-probe.mjs';
test('automation cached probe requires fresh healthy state and never forwards payload',()=>{
 const now=Date.now(),valid={status:'operational',checked_at:new Date(now).toISOString(),private_data:'secret'};
 assert.equal(automationProbeResult(valid,now).ok,true);
 for(const value of [{...valid,status:'degraded'},{...valid,checked_at:new Date(now-90001).toISOString()},{...valid,checked_at:new Date(now+30001).toISOString()},{}])assert.equal(automationProbeResult(value,now).ok,false);
 assert.equal(JSON.stringify(automationProbeResult(valid,now)).includes('secret'),false);
});
