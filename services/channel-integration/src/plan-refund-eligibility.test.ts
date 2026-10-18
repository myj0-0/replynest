import test from 'node:test';
import assert from 'node:assert/strict';
import {planRefundEligibility} from './plan-refund-eligibility.js';
const purchase={amount_minor:'9900',cash_minor:'7900',gift_minor:'2000',created_at:'2026-10-15T02:30:00Z',period_start:'2026-10-15T02:30:00Z',period_end:'2026-11-15T02:30:00Z',subscription_period_end:'2026-11-15T02:30:00Z',subscription_status:'active',refund_status:null};
test('refund preview preserves funding and charges 1% within 24 hours',()=>{
 const r=planRefundEligibility(purchase,new Date('2026-10-16T02:30:00Z'));
 assert.equal(r.can_refund,true);assert.equal(r.refund_preview?.amount_minor,9801);
 assert.equal(r.refund_preview?.cash_minor,7821);assert.equal(r.refund_preview?.gift_minor,1980);
});
test('after 24 hours preview deducts used days; 168 hours remains eligible',()=>{
 const r=planRefundEligibility(purchase,new Date('2026-10-22T02:30:00Z'));
 assert.equal(r.can_refund,true);assert.equal(r.refund_preview?.used_days,7);
 assert.equal(r.refund_preview?.usage_minor,2235);
});
test('past the window explains why no refund button is offered',()=>{
 assert.equal(planRefundEligibility(purchase,new Date('2026-10-22T02:30:00.001Z')).refund_unavailable_reason,'refund_window_expired');
});
test('changed, canceled or already-refunded terms do not promise refunds',()=>{
 for(const delta of [{subscription_status:'canceled'},{subscription_period_end:'2026-12-15T02:30:00Z'},{refund_status:'paid'}])assert.equal(planRefundEligibility({...purchase,...delta},new Date('2026-10-16T02:30:00Z')).can_refund,false);
});
