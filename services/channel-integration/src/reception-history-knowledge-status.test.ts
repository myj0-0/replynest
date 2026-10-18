import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeHistoryCursor,validateHistoryJobsQuery,historyJobReceipt} from './reception-history-knowledge-status.js';
const id='aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',at='2026-10-06T00:00:00.123456Z';
const row=()=>({job_id:id,request_id:id,state:'succeeded',created_at_text:at,document_id:id,call_id:id,attempted_at:new Date(),
 receipt_call_id:id,receipt_status:'succeeded',reserved_micros:'200000',charged_micros:'161000',cost_nano_cny:'161000',input_tokens:'100',output_tokens:'30',cached_input_tokens:'0'});
test('history status query permits only one bounded cursor or exact request ID',()=>{
 const cursor=Buffer.from(JSON.stringify({at,id})).toString('base64url');assert.deepEqual(decodeHistoryCursor(cursor),{at,id});
 assert.deepEqual(validateHistoryJobsQuery(new URLSearchParams({cursor})),{cursor});
 for(const value of ['tenant=b','limit=10000','cursor=x&requestId='+id,'requestId='+id+'&requestId='+id,'cursor='+('x'.repeat(257)), 'cursor=','requestId=bad'])assert.throws(()=>validateHistoryJobsQuery(new URLSearchParams(value)));
 for(const value of [{at,id,sql:'never'}, {at:'today',id}, {at,id:'wrong'}])assert.throws(()=>decodeHistoryCursor(Buffer.from(JSON.stringify(value)).toString('base64url')));
 assert.throws(()=>decodeHistoryCursor(Buffer.from(`{"at":"${at}","id":"wrong","id":"${id}"}`).toString('base64url')));
});
test('failed output with a successful billing receipt is still charged; no raw provider details',()=>{
 const receipt=historyJobReceipt({...row(),state:'failed',reason:'credential_marker',prompt_hash:'private_marker'});
 assert.deepEqual(receipt.billing,{state:'charged',chargedMicros:'161000',reservedMicros:null});assert.equal(receipt.documentId,null);
 assert.ok(!JSON.stringify(receipt).includes('marker'));assert.equal(Object.hasOwn(receipt,'call_id'),false);
});
test('unknown/misbound/expired billing is not presented as confirmed zero cost',()=>{
 for(const change of [{receipt_call_id:null},{receipt_status:'abandoned'},{receipt_status:'failed',charged_micros:'0',cost_nano_cny:null},
  {receipt_status:'reserved',state:'uncertain'},{charged_micros:'300000'},{input_tokens:'bad'},{cost_nano_cny:null}])assert.equal(historyJobReceipt({...row(),...change}).billing.state,'review_required');
 assert.equal(historyJobReceipt({...row(),receipt_status:'failed',charged_micros:'0'}).billing.state,'not_charged');
 assert.equal(historyJobReceipt({...row(),state:'reserved',document_id:null,receipt_status:'reserved'}).billing.state,'reserved');
 assert.equal(historyJobReceipt({...row(),state:'queued',document_id:null,call_id:null,attempted_at:null}).billing.state,'not_requested');
 assert.equal(historyJobReceipt({...row(),state:'uncertain',document_id:null,call_id:null,attempted_at:null}).billing.state,'review_required');
});
