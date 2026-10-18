import test from 'node:test';import assert from 'node:assert/strict';
import {validateReferralThreshold} from './referral-threshold.js';
import {validateGrowthPolicy,defaultGrowthPolicy} from './growth-policy-core.js';
const input={cash_minor:10000,expected_version:3,reason:'合成现金门槛调整测试说明'};
test('threshold accepts integer minor units, including zero, and bounded versions',()=>{for(const cash_minor of [0,1,10000,100000000])assert.equal(validateReferralThreshold({...input,cash_minor}).cash,cash_minor);});
test('threshold refuses coercion, non-money, unknown keys and short reasons',()=>{for(const raw of [null,[],{...input,cash_minor:true},{...input,cash_minor:'100'},{...input,cash_minor:-1},{...input,cash_minor:1.5},{...input,cash_minor:100000001},{...input,expected_version:'3'},{...input,expected_version:0},{...input,reason:'short'},{...input,other:true}])assert.throws(()=>validateReferralThreshold(raw as any));});
test('legacy policies stay compatible and configured cash threshold survives validation',()=>{assert.equal(validateGrowthPolicy(defaultGrowthPolicy).inviter_min_cash_minor,undefined);for(const n of [0,1,10000])assert.equal(validateGrowthPolicy({...defaultGrowthPolicy,inviter_min_cash_minor:n}).inviter_min_cash_minor,n);assert.throws(()=>validateGrowthPolicy({...defaultGrowthPolicy,inviter_min_cash_minor:-1}));});
