import test from 'node:test';
import assert from 'node:assert/strict';
import {appCapabilities,capabilityVersion,capabilityCatalog} from './extension-capabilities.js';
import {exampleDefinition} from './extension-core.js';
import {validateGeneration,UnsupportedCapabilityError} from './extension-qwen.js';
import {rotationExample,simulateAutomation,validateAutomationPreview} from './automation-preview.js';
const envelope={kind:'app',capability_version:capabilityVersion,required_capabilities:appCapabilities(exampleDefinition),definition:exampleDefinition};
const sample=(id:string,assignee_ref:string|null=null,status='open')=>({id,text:'申请退款',assignee_ref,status});
test('bounded JavaScript is explicit in the AI capability manifest',()=>{
 const definition={...exampleDefinition,code:{language:'javascript' as const,source:'return {...input,amount:input.amount*0.8};'}};
 const required_capabilities=appCapabilities(definition);assert(required_capabilities.includes('code.execute'));
 assert.equal(validateGeneration({...envelope,definition,required_capabilities}).kind,'app');
 assert.throws(()=>validateGeneration({...envelope,definition}),/capability_manifest_mismatch/);
 for(const code of [{language:'python',source:'pass'},{language:'javascript',source:'x'.repeat(8001)},{language:'javascript',source:'return input;',permissions:['network']}])assert.throws(()=>validateGeneration({...envelope,definition:{...definition,code},required_capabilities}));
});
test('new rule capabilities are enforced in AI manifests',()=>{
  for(const operator of ['not_equals','gt','lt','lte','starts_with','ends_with'] as const){
    const definition=structuredClone(exampleDefinition);
    definition.workflow.rules[0].when=operator==='starts_with'||operator==='ends_with'
      ?{field:'subject',operator,value:'VIP'}:{field:'amount',operator,value:500};
    const required_capabilities=appCapabilities(definition);
    assert.ok(required_capabilities.includes(`rule.${operator}`));
    assert.equal(capabilityCatalog.capabilities.find(c=>c.id===`rule.${operator}`)?.status,'available');
    assert.equal(validateGeneration({...envelope,definition,required_capabilities}).kind,'app');
    assert.throws(()=>validateGeneration({...envelope,definition,required_capabilities:required_capabilities.filter(c=>c!==`rule.${operator}`)}),/capability_manifest_mismatch/);
  }
});
test('catalog IDs are unique; app envelope must match actual capabilities exactly',()=>{
  assert.equal(new Set(capabilityCatalog.capabilities.map(c=>c.id)).size,capabilityCatalog.capabilities.length);
  assert.equal(validateGeneration(envelope).kind,'app');
  assert.throws(()=>validateGeneration({...envelope,capability_version:'old'}),/capability_version_mismatch/);
  for(const required_capabilities of [[],[...envelope.required_capabilities,'conversation.assign'],[...envelope.required_capabilities,envelope.required_capabilities[0]]])assert.throws(()=>validateGeneration({...envelope,required_capabilities}));
  assert.throws(()=>validateGeneration({...envelope,definition:{...exampleDefinition,code:'fetch(secret)'}}));
  assert.throws(()=>validateGeneration({...envelope,definition:{...exampleDefinition,workflow:{trigger:'schedule',rules:[]}}}));
  assert.throws(()=>validateGeneration({kind:'unsupported',capability_version:capabilityVersion,missing_capabilities:['schedule.execute']}),UnsupportedCapabilityError);
});
test('preview envelopes cannot be published as app definitions',()=>{
  const preview={kind:'automation_preview',capability_version:capabilityVersion,required_capabilities:['preview.rotation'],definition:rotationExample};
  assert.equal(validateGeneration(preview).kind,'automation_preview');
  assert.throws(()=>validateGeneration({...preview,kind:'app'}));
  assert.throws(()=>validateGeneration({...preview,required_capabilities:['schedule.execute']}));
});
test('Shanghai midnight rotation is pure, bounded and preserves existing assignments',()=>{
  const samples=[sample('1'),sample('2','管理员'),sample('3',null,'resolved'),sample('4'),sample('5','客服A')];
  const before=JSON.stringify(samples);
  const result=simulateAutomation({...rotationExample,max_actions:1},samples,'2026-09-27T16:00:00Z');
  assert.equal(result.executed,false);assert.equal(result.real_conversations_read,0);assert.equal(result.planned_count,1);
  assert.deepEqual(result.results.map(r=>r.reason),['would_assign','preserve_manual_assignment','status_excluded','action_limit','already_assigned']);
  assert.equal(result.results[0].target,'客服A');assert.equal(result.next_runs[0].at,'2026-09-28T16:00:00.000Z');assert.equal(result.next_runs[0].assignee_ref,'客服B');
  assert.equal(JSON.stringify(samples),before);
  assert.equal(simulateAutomation(rotationExample,[sample('1')],'2026-09-27T15:59:00.123Z').planned_count,0);
});
test('keyword preview is literal matching, not semantic classification',()=>{
  const definition={...rotationExample,trigger:'manual_sample',slots:[],keywords:['退款'],assignee_ref:'主管',overwrite_assigned:true};
  const result=simulateAutomation(definition,[sample('1','客服A'),{...sample('2'),text:'态度不好'}],'2026-09-27T16:00:00Z');
  assert.deepEqual(result.results.map(r=>r.reason),['would_assign','keyword_not_matched']);assert.deepEqual(result.next_runs,[]);
});
test('reject malformed dates, duplicate slots, hidden actions and oversized samples',()=>{
  for(const instant of ['2026-02-30T00:00:00Z','2026-09-28','2026-09-28T00:00:00+08:00'])assert.throws(()=>simulateAutomation(rotationExample,[],instant));
  assert.throws(()=>validateAutomationPreview({...rotationExample,slots:[rotationExample.slots[0],rotationExample.slots[0]]}));
  assert.throws(()=>validateAutomationPreview({...rotationExample,enabled:true}));
  assert.throws(()=>validateAutomationPreview({...rotationExample,max_actions:101}));
  assert.throws(()=>simulateAutomation(rotationExample,[sample('1'),sample('1')],'2026-09-27T16:00:00Z'));
  assert.throws(()=>simulateAutomation(rotationExample,Array.from({length:101},(_,i)=>sample(String(i))),'2026-09-27T16:00:00Z'));
});
