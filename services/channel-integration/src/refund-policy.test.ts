import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteRefund } from './refund-policy.js';
import { parsePrice } from './plan-pricing.js';
const start=new Date('2026-09-01T00:00:00Z'),end=new Date('2026-10-01T00:00:00Z');
const after=(hours:number)=>new Date(start.getTime()+hours*3600000);
test('24h boundary waives usage, after 24h rounds used days up, 168h inclusive',()=>{
  assert.equal(quoteRefund(30000,start,start,end,after(24)).amount_minor,29700);
  const q=quoteRefund(30000,start,start,end,after(24+1/3600));
  assert.equal(q.used_days,2);assert.equal(q.usage_minor,2000);assert.equal(q.amount_minor,27700);
  assert.equal(quoteRefund(30000,start,start,end,after(168)).amount_minor,22700);
  assert.throws(()=>quoteRefund(30000,start,start,end,after(168+1/3600)),/window_expired/);
});
test('annual uses discounted actual payment and calendar term; future renewal not used yet',()=>{
  const q=quoteRefund(240000,start,start,new Date('2027-09-01T00:00:00Z'),after(25));
  assert.equal(q.total_days,365);assert.equal(q.usage_minor,Math.round(240000*2/365));assert.equal(q.fee_minor,2400);
  assert.equal(quoteRefund(30000,start,end,new Date('2026-11-01T00:00:00Z'),after(48)).usage_minor,0);
  assert.throws(()=>quoteRefund(30000,start,start,end,after(-1)),/invalid/);
});
test('price input exact cents and optional original price',()=>{
  assert.equal(parsePrice('49.99'),4999);assert.equal(parsePrice('',true),null);
  for(const value of ['0','-1','1.001','1e2','NaN',49])assert.throws(()=>parsePrice(value));
});
