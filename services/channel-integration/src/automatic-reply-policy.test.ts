import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticReplyDecision,AUTOMATIC_REPLY_CONSENT_VERSION,AUTOMATIC_SEND_CONSENT_VERSION,type AutomaticReplyFacts} from './automatic-reply-policy.js';
const ready:AutomaticReplyFacts={executorAvailable:true,consentVersion:AUTOMATIC_REPLY_CONSENT_VERSION,sendConsentVersion:AUTOMATIC_SEND_CONSENT_VERSION,tenantActive:true,
  generateEnabled:true,sendEnabled:true,latestCustomerMessage:true,humanResponded:false,channelReplyable:true,pointsAvailable:true,
  generated:true,fallback:false,requiresHumanApproval:false,evidenceCandidate:true,confidencePercent:95,thresholdPercent:90};
test('only fully eligible content can be considered for automatic delivery',()=>assert.equal(automaticReplyDecision(ready).action,'send'));
test('historical preference is not consent for live automation',()=>assert.equal(automaticReplyDecision({...ready,consentVersion:null}).reason,'fresh_consent_required'));
test('draft-only consent cannot authorize public disclosure',()=>{
  for(const version of [null,AUTOMATIC_REPLY_CONSENT_VERSION,'obsolete'])assert.equal(automaticReplyDecision({...ready,sendConsentVersion:version}).reason,'fresh_send_consent_required');
});
test('malformed trusted facts fail closed at runtime',()=>{
  for(const change of [{humanResponded:undefined},{pointsAvailable:1},{sendEnabled:'true'},{requiresHumanApproval:null}]){
    assert.equal(automaticReplyDecision({...ready,...change} as unknown as AutomaticReplyFacts).action,'skip');
  }
});
test('disabled runtime, cancelled opt-in, exhausted points and stale messages never send',()=>{
  for(const changes of [{executorAvailable:false},{tenantActive:false},{generateEnabled:false},{pointsAvailable:false},{latestCustomerMessage:false},{humanResponded:true}]) {
    assert.equal(automaticReplyDecision({...ready,...changes}).action,'skip');
  }
});
test('fallback, weak evidence, human approval, closed channel and draft-only opt-in stay drafts',()=>{
  for(const changes of [{fallback:true},{evidenceCandidate:false},{requiresHumanApproval:true},{confidencePercent:60},{channelReplyable:false},{sendEnabled:false},{generated:false},{thresholdPercent:NaN},{confidencePercent:NaN}]) {
    assert.equal(automaticReplyDecision({...ready,...changes}).action,'draft');
  }
});
