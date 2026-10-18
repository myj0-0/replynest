import test from 'node:test';
import assert from 'node:assert/strict';
import {executeMassCampaign,type MassPorts} from './mass-campaign-executor.js';
import {massTextPayload,massStatus} from './wechat-mass-core.js';
const job={tenantId:'t',campaignId:'c',batchId:'b'};
function setup(overrides:Partial<MassPorts>={}) {const calls:string[]=[];const p:MassPorts={claim:async()=>true,prepare:async()=>({openIds:['one','two'],content:'text',clientId:'a'.repeat(32)}),commitSubmitting:async()=>{calls.push('barrier');return true;},submit:async()=>{calls.push('submit');return '123';},finish:async(_,s)=>{calls.push(s);},...overrides};return {p,calls};}
test('mass acceptance is submitted, never delivered',async()=>{const {p,calls}=setup();assert.equal(await executeMassCampaign(job,p),'submitted');assert.deepEqual(calls,['barrier','submit','submitted']);});
test('ineligible or cancelled campaign does not submit',async()=>{for(const overrides of [{prepare:async()=>null},{commitSubmitting:async()=>false}]){const {p,calls}=setup(overrides);assert.equal(await executeMassCampaign(job,p),'blocked');assert.ok(!calls.includes('submit'));}});
test('only confirmed pre-barrier denials can defer',async()=>{
 for(const denial of [{prepare:async()=>null},{commitSubmitting:async()=>false}]){
  let deferrals=0;const {p,calls}=setup({...denial,defer:async()=>{deferrals++;return true;}});
  assert.equal(await executeMassCampaign(job,p),'deferred');assert.equal(deferrals,1);assert.ok(!calls.includes('submit'));assert.ok(!calls.includes('blocked'));
 }
 for(const ambiguous of [{commitSubmitting:async()=>{throw Error('lost commit');}},{submit:async()=>{throw Error('timeout');}}]){
  let deferrals=0;const {p}=setup({...ambiguous,defer:async()=>{deferrals++;return true;}});
  assert.equal(await executeMassCampaign(job,p),'uncertain');assert.equal(deferrals,0);
 }
});
test('timeout and post-submit receipt persistence failure are uncertain',async()=>{const {p}=setup({submit:async()=>{throw new Error('timeout');}});assert.equal(await executeMassCampaign(job,p),'uncertain');const q=setup({finish:async(_,s)=>{if(s==='submitted')throw new Error('db down');}}).p;assert.equal(await executeMassCampaign(job,q),'uncertain');});
test('duplicate mass jobs never submit',async()=>{const {p,calls}=setup({claim:async()=>false});assert.equal(await executeMassCampaign(job,p),'duplicate');assert.equal(calls.length,0);});
test('malformed batch is rejected before persisting a send barrier',async()=>{
  const {p,calls}=setup({prepare:async()=>({openIds:['one'],content:'text',clientId:'a'.repeat(32)})});
  assert.equal(await executeMassCampaign(job,p),'failed');assert.deepEqual(calls,['failed']);
});
test('mutation after the barrier cannot change the outgoing recipient snapshot',async()=>{
  const {p,calls}=setup({commitSubmitting:async(_,batch)=>{batch.openIds.push('unexpected');return true;}});
  assert.equal(await executeMassCampaign(job,p),'uncertain');assert.ok(!calls.includes('submit'));
});
test('zero or malformed provider receipt remains uncertain rather than successful',async()=>{
  for(const receipt of ['0','not-an-id','1'.repeat(21)]){
    const {p}=setup({submit:async()=>receipt});assert.equal(await executeMassCampaign(job,p),'uncertain');
  }
});
test('recipient count bounds and stable id are required',()=>{assert.throws(()=>massTextPayload(['a','a'],'text','a'.repeat(32)));assert.throws(()=>massTextPayload(['a','b'],'text',''));assert.equal(massTextPayload(['a','b','a'],'text','a'.repeat(32)).touser.length,2);});
test('status must match receipt; sending is not success',()=>{assert.equal(massStatus({msg_id:123,msg_status:'SENDING'},'123'),'sending');assert.equal(massStatus({msg_id:123,msg_status:'SEND_SUCCESS'},'123'),'succeeded');assert.throws(()=>massStatus({msg_id:124,msg_status:'SEND_SUCCESS'},'123'));assert.throws(()=>massStatus({msg_id:123,msg_status:'UNKNOWN'},'123'));});
