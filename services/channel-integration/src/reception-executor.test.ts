import test from 'node:test';
import assert from 'node:assert/strict';
import {executeReception,dispatchPreparedReception,type ReceptionPorts,type ReceptionDraft} from './reception-executor.js';
import {AUTOMATIC_REPLY_CONSENT_VERSION,AUTOMATIC_SEND_CONSENT_VERSION,type AutomaticReplyFacts} from './automatic-reply-policy.js';
const job={tenantId:'a',jobId:'j',messageId:'m'};
const facts:AutomaticReplyFacts={executorAvailable:true,consentVersion:AUTOMATIC_REPLY_CONSENT_VERSION,sendConsentVersion:AUTOMATIC_SEND_CONSENT_VERSION,tenantActive:true,generateEnabled:true,sendEnabled:true,latestCustomerMessage:true,humanResponded:false,channelReplyable:true,pointsAvailable:true,generated:false,fallback:false,requiresHumanApproval:false,evidenceCandidate:false,confidencePercent:0,thresholdPercent:90};
const draft:ReceptionDraft={text:'Verified reply',generated:true,fallback:false,requiresHumanApproval:false,evidenceCandidate:true,confidencePercent:95};
function setup(overrides:Partial<ReceptionPorts>={}){
  const calls:string[]=[];
  const p:ReceptionPorts={claim:async()=>true,facts:async()=>facts,generate:async()=>{calls.push('generate');return draft;},saveDraft:async()=>{calls.push('draft');},assess:async()=>({requiresHumanApproval:false,evidenceCandidate:true,confidencePercent:95}),commitSending:async()=>{calls.push('barrier');return true;},send:async()=>{calls.push('send');return 'accepted';},finish:async(_,s)=>{calls.push(s);},...overrides};
  return {p,calls};
}
test('draft is saved and uncertainty barrier precedes send',async()=>{const {p,calls}=setup();assert.equal(await executeReception(job,p),'accepted');assert.deepEqual(calls,['generate','draft','barrier','send','accepted']);});
test('duplicate never generates or sends',async()=>{const {p,calls}=setup({claim:async()=>false});assert.equal(await executeReception(job,p),'duplicate');assert.deepEqual(calls,[]);});
test('draft mode never sends',async()=>{const {p,calls}=setup({facts:async()=>({...facts,sendEnabled:false})});assert.equal(await executeReception(job,p),'draft');assert.ok(!calls.includes('send'));});
test('human reply during generation cancels sending',async()=>{let reads=0;const {p,calls}=setup({facts:async()=>({...facts,humanResponded:++reads>1})});assert.equal(await executeReception(job,p),'skipped');assert.ok(!calls.includes('send'));});
test('send timeout is uncertain, not retryable failure',async()=>{const {p}=setup({send:async()=>{throw new Error('timeout');}});assert.equal(await executeReception(job,p),'uncertain');});
test('lost consent prevents generation',async()=>{const {p,calls}=setup({facts:async()=>({...facts,consentVersion:null})});assert.equal(await executeReception(job,p),'skipped');assert.ok(!calls.includes('generate'));});
test('send consent withdrawn during generation keeps the result private',async()=>{
  let reads=0;const {p,calls}=setup({facts:async()=>({...facts,sendConsentVersion:++reads>1?null:AUTOMATIC_SEND_CONSENT_VERSION})});
  assert.equal(await executeReception(job,p),'draft');assert.ok(!calls.includes('barrier'));assert.ok(!calls.includes('send'));
});
test('uncertain send-barrier commit stays uncertain',async()=>{const {p,calls}=setup({commitSending:async()=>{throw new Error('connection lost');}});assert.equal(await executeReception(job,p),'uncertain');assert.ok(!calls.includes('send'));});

test('generator extra fields cannot override current tenant authorization',async()=>{
  const {p,calls}=setup({facts:async()=>({...facts,sendEnabled:false}),generate:async()=>({...draft,sendEnabled:true,consentVersion:AUTOMATIC_REPLY_CONSENT_VERSION})});
  assert.equal(await executeReception(job,p),'draft');assert.ok(!calls.includes('send'));
});
test('fresh human approval requirement cannot be cleared by generated output',async()=>{
  const {p,calls}=setup({facts:async()=>({...facts,requiresHumanApproval:true})});
  assert.equal(await executeReception(job,p),'draft');assert.ok(!calls.includes('send'));
});
test('malformed generated safety fields fail closed',async()=>{
  for(const change of [{fallback:undefined},{requiresHumanApproval:'false'},{confidencePercent:101},{confidencePercent:-1},{text:42}]){
    const {p,calls}=setup({generate:async()=>({...draft,...change}) as ReceptionDraft});
    assert.equal(await executeReception(job,p),'failed');assert.ok(!calls.includes('send'));
  }
});
test('model self-score cannot override server-side weak evidence or risk',async()=>{
  for(const assessment of [{requiresHumanApproval:false,evidenceCandidate:false,confidencePercent:100},{requiresHumanApproval:true,evidenceCandidate:true,confidencePercent:100},{requiresHumanApproval:false,evidenceCandidate:true,confidencePercent:20}]){
    const {p,calls}=setup({generate:async()=>({...draft,confidencePercent:100}),assess:async()=>assessment});
    assert.equal(await executeReception(job,p),'draft');assert.ok(!calls.includes('send'));
  }
});
test('invalid provider outcome after the barrier remains uncertain',async()=>{
  const {p}=setup({send:async()=> 'unexpected' as 'accepted'});assert.equal(await executeReception(job,p),'uncertain');
});
test('malformed server-side assessment never sends',async()=>{
  const {p,calls}=setup({assess:async()=>({requiresHumanApproval:false,evidenceCandidate:true,confidencePercent:NaN})});
  assert.equal(await executeReception(job,p),'failed');assert.ok(!calls.includes('send'));
});

test('durable defer releases a qualified worker without a submit barrier, timer or send',async()=>{
 const {p,calls}=setup({defer:async()=>{calls.push('persist_wait');return true;}});
 assert.equal(await executeReception(job,p),'waiting');assert.deepEqual(calls,['generate','draft','persist_wait']);
});
test('failed/unknown wait persistence never falls through to immediate send',async()=>{
 const {p,calls}=setup({defer:async()=>{throw Error('commit_unknown');}});
 assert.equal(await executeReception(job,p),'failed');assert.deepEqual(calls,['generate','draft','failed']);
});
test('registered defer ports cannot silently bypass waiting with false/malformed results',async()=>{
 for(const result of [false,undefined,'true',1]){
  const {p,calls}=setup({defer:async()=>result as boolean});
  assert.equal(await executeReception(job,p),'failed');assert.ok(!calls.includes('barrier')&&!calls.includes('send'));
 }
});
test('resuming a frozen answer repeats gates without any generation or save',async()=>{
 const {p,calls}=setup();assert.equal(await dispatchPreparedReception(job,draft,p),'accepted');
 assert.deepEqual(calls,['barrier','send','accepted']);
});
test('human reply/pause-equivalent freshness/revoked consent during wait prevent submission',async()=>{
 for(const changed of [{humanResponded:true},{latestCustomerMessage:false},{consentVersion:null},{sendConsentVersion:null},{executorAvailable:false}]){
  const {p,calls}=setup({facts:async()=>({...facts,...changed})});
  assert.notEqual(await dispatchPreparedReception(job,draft,p),'accepted');
  assert.ok(!calls.includes('barrier')&&!calls.includes('send')&&!calls.includes('generate'));
 }
});
test('stored model self-confidence cannot override changed independent evidence on resume',async()=>{
 const {p,calls}=setup({assess:async()=>({evidenceCandidate:false,requiresHumanApproval:false,confidencePercent:100})});
 assert.equal(await dispatchPreparedReception(job,draft,p),'draft');assert.deepEqual(calls,['draft']);
});
test('resumed submit uncertainty still cannot be treated as a retryable failure',async()=>{
 const {p,calls}=setup({commitSending:async()=>{calls.push('barrier');throw Error('unknown');}});
 assert.equal(await dispatchPreparedReception(job,draft,p),'uncertain');assert.deepEqual(calls,['barrier','uncertain']);
});
