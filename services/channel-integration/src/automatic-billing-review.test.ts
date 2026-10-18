import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticBillingReview} from './automatic-billing-review.js';
const base={generation_state:'uncertain',generation_attempted:true,billing_state:'failed',billing_error:null,charged_micros:'0',held_micros:'0'};
test('provider usage uncertainty is not presented as confirmed zero provider cost',()=>{
 assert.equal(automaticBillingReview({...base,billing_error:'automatic_provider_cost_unknown'}),'provider_cost_unknown');
 for(const error of ['automatic_embedding_cost_unknown','automatic_verifier_cost_unknown'])
  assert.equal(automaticBillingReview({...base,billing_error:error}),'provider_cost_unknown');
 assert.equal(automaticBillingReview({...base,billing_state:'abandoned'}),'provider_cost_unknown');
});
test('lost reservation remains held; expiry before an attempt releases the hold',()=>{
 assert.equal(automaticBillingReview({...base,billing_state:'reserved',held_micros:'345000',generation_attempted:false}),'held');
 assert.equal(automaticBillingReview({...base,billing_state:'abandoned',generation_attempted:false}),'released');
});
test('confirmed point settlement does not repair the immutable generation outcome',()=>{
 assert.equal(automaticBillingReview({...base,billing_state:'succeeded',charged_micros:'127000'}),'charged');
 assert.equal(automaticBillingReview({...base,billing_state:'failed',billing_error:'automatic_provider_rejected'}),'not_charged');
});
test('missing or contradictory receipts require review, not free or success',()=>{
 assert.equal(automaticBillingReview({...base,billing_state:null,charged_micros:null,held_micros:null}),'billing_unconfirmed');
 assert.equal(automaticBillingReview({...base,generation_state:null,billing_state:null,charged_micros:null,held_micros:null}),'not_requested');
 for(const changed of [{charged_micros:'invalid'},{charged_micros:'-1'},{charged_micros:'9223372036854775808'},
  {charged_micros:'1'},{held_micros:'1'},{billing_state:'unexpected'}])assert.equal(automaticBillingReview({...base,...changed}),'billing_unconfirmed');
});
