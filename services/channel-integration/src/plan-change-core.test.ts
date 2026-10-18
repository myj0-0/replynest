import test from 'node:test';
import assert from 'node:assert/strict';
import {quotePlanChange,quoteChangedPlanRefund,remainingPlanValue,type PlanValue} from './plan-change-core.js';
const start='2026-10-15T00:00:00Z',end='2026-11-15T00:00:00Z',at='2026-10-16T00:00:00Z',term='2026-11-16T00:00:00Z';
const value:PlanValue={purchase_id:'original',paid_at:start,original_minor:9900,value_minor:9900,cash_minor:7900,gift_minor:2000,gift_allocations:[{entry_id:'gift',amount_minor:2000,expires_at:'2027-01-01T00:00:00Z'}],starts:start,ends:end};
test('upgrade uses original value, current target price, fixed expiry and integer fen',()=>{
 const q=quotePlanChange([value],at,end,term,29900,'upgrade');assert.equal(q.carry_minor,9580);assert.equal(q.due_minor,28936-9580);assert.equal(q.period_end,end);assert.equal(q.values[0].paid_at,start);assert.equal(q.values[0].original_minor,9900);
});
test('downgrade converts remaining value into time, never cash or new refund window',()=>{
 const q=quotePlanChange([value],at,end,term,4900,'downgrade');assert.equal(q.due_minor,0);assert.ok(+new Date(q.period_end)>+new Date(end));assert.equal((+new Date(q.period_end)-+new Date(at))%1000,0);assert.throws(()=>quoteChangedPlanRefund(q.values,'2026-10-23T00:00:00.001Z'),/refund_window_expired/);
});
test('refund preserves original sources, gift expiry and original 1% fee',()=>{
 const q=quotePlanChange([value],at,end,term,4900,'downgrade'),r=quoteChangedPlanRefund(q.values,at);assert.equal(r.fee_minor,99);assert.equal(r.net_minor,9580-99);assert.equal(r.cash_minor+r.gift_minor,r.net_minor);assert.equal(r.gift_allocations[0].expires_at,value.gift_allocations[0].expires_at);assert.ok(r.cash_minor<=7900);
});
test('cannot manufacture refundable value or bypass malformed/fan-out limits',()=>{
 assert.throws(()=>quotePlanChange([value,value],at,end,term,4900,'downgrade'),/plan_value_requires_review/);assert.throws(()=>remainingPlanValue({...value,value_minor:10000},at),/plan_value_requires_review/);assert.equal(remainingPlanValue(value,end).value_minor,0);
});
