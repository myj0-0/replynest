import test from 'node:test';
import assert from 'node:assert/strict';
import {withHistoryModelDeadline} from './reception-history-model-deadline.js';
test('whole-operation deadline bounds stalled fetch/stream even when operation ignores abort; one call, no retry',async()=>{
 let calls=0,signal:AbortSignal|undefined;const started=Date.now();
 await assert.rejects(()=>withHistoryModelDeadline(async s=>{calls++;signal=s;return new Promise(()=>{});},30),/history_provider_deadline/);
 assert.equal(calls,1);assert.equal(signal?.aborted,true);assert.ok(Date.now()-started<1000);
});
test('completed or rejected operation clears timer; bounds cannot be model-inflated beyond 25 seconds',async()=>{
 let signal:AbortSignal|undefined;
 assert.equal(await withHistoryModelDeadline(async s=>{signal=s;return 'ready';},20),'ready');
 await new Promise(r=>setTimeout(r,30));assert.equal(signal?.aborted,false);
 await assert.rejects(()=>withHistoryModelDeadline(async()=>{throw Error('controlled');},20),/controlled/);
 for(const n of [0,25001,NaN,1.5])await assert.rejects(()=>withHistoryModelDeadline(async()=>assert.fail('no operation'),n),/invalid_history_model_deadline/);
});
