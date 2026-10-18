import test from 'node:test';
import assert from 'node:assert/strict';
import {rotationExample} from './automation-preview.js';
import {validateRule,nextRuleRun,ruleMembers,ruleTarget} from './automation-rule-core.js';
const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
const d={...rotationExample,slots:rotationExample.slots.map((s,i)=>({...s,assignee_ref:i?b:a}))};
test('durable rules require real member identifiers; deduplicate bindings',()=>{
 assert.throws(()=>validateRule(rotationExample),/rule_member_binding_required/);
 assert.deepEqual(ruleMembers(validateRule(d)),[a,b]);
 assert.throws(()=>validateRule({...d,enabled:true}));
});
test('Shanghai weekly next-run excludes current slot and chooses next day',()=>{
 assert.equal(nextRuleRun(d,new Date('2026-09-27T15:59:59Z')),'2026-09-27T16:00:00.000Z');
 assert.equal(nextRuleRun(d,new Date('2026-09-27T16:00:00Z')),'2026-09-28T16:00:00.000Z');
 assert.equal(ruleTarget(d,new Date('2026-09-27T16:00:00Z')),a);
 assert.equal(ruleTarget(d,new Date('2026-09-28T16:00:00Z')),b);
 assert.equal(ruleTarget(d,new Date('2026-09-28T16:01:00Z')),null);
});
test('keyword rules remain manual plans without scheduler triggers',()=>{
 const manual=validateRule({...d,trigger:'manual_sample',slots:[],keywords:['退款'],assignee_ref:a});
 assert.equal(nextRuleRun(manual,new Date()),null);assert.equal(ruleTarget(manual,new Date()),a);
});
