import test from 'node:test';
import assert from 'node:assert/strict';
import {modelProbeResult} from './model-probe.mjs';
test('model cache requires fresh successful probe, not HTTP alone', () => {
  const now=Date.now(), valid={status:'operational',checked_at:new Date(now).toISOString(),latency_ms:321};
  assert.equal(modelProbeResult(valid,now).ok,true);
  assert.equal(modelProbeResult(valid,now).latency_ms,321);
  assert.equal(modelProbeResult({...valid,status:'degraded'},now).ok,false);
  assert.equal(modelProbeResult(valid,now+600001).ok,false);
  assert.equal(modelProbeResult({},now).ok,false);
  assert.equal(modelProbeResult(valid,now-61000).ok,false);
});
