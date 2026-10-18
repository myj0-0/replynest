import test from 'node:test';
import assert from 'node:assert/strict';
import {canManageExtensions,definitionHash,exampleDefinition,runExtension,validateDefinition} from './extension-core.js';
const copy=()=>structuredClone(exampleDefinition);

test('numeric comparisons respect equal boundaries and do not coerce types',()=>{
  const expected={gt:[false,false,true],gte:[false,true,true],lt:[true,false,false],lte:[true,true,false],not_equals:[true,false,true]};
  for(const [operator,matches] of Object.entries(expected)){
    const d=copy();d.workflow.rules[0].when={field:'amount',operator:operator as typeof d.workflow.rules[0]['when']['operator'],value:500};
    for(const [i,amount] of [499,500,501].entries())assert.equal(runExtension(d,{subject:'x',amount,priority:'普通'}).trace[0].matched,matches[i],`${operator} ${amount}`);
    assert.throws(()=>runExtension(d,{subject:'x',amount:'500',priority:'普通'}));
  }
});
test('text boundaries are literal, case sensitive and reject numeric fields',()=>{
  for(const operator of ['starts_with','ends_with'] as const){
    const d=copy();d.workflow.rules[0].when={field:'subject',operator,value:'VIP'};
    for(const [subject,expected] of [['VIP',true],['vip',false],['xVIPx',false],[operator==='starts_with'?'VIP客户':'客户VIP',true]] as const)
      assert.equal(runExtension(d,{subject,amount:1,priority:'普通'}).trace[0].matched,expected);
    d.workflow.rules[0].when={field:'amount',operator,value:1};assert.throws(()=>validateDefinition(d));
  }
  for(const operator of ['gt','lt','lte'] as const){const d=copy();d.workflow.rules[0].when={field:'subject',operator,value:'500'};assert.throws(()=>validateDefinition(d));}
});
test('not_equals never matches an absent optional field; strict boolean and date validation',()=>{
  const d=copy();d.fields[0].required=false;d.workflow.rules[0].when={field:'subject',operator:'not_equals',value:'x'};
  for(const subject of [undefined,null,''])assert.equal(runExtension(d,{subject,amount:1,priority:'普通'}).trace[0].matched,false);
  d.fields.push({key:'checked',label:'确认',type:'checkbox',required:false});
  d.workflow.rules[0].when={field:'checked',operator:'not_equals',value:true};
  assert.equal(runExtension(d,{checked:false,amount:1,priority:'普通'}).trace[0].matched,true);
  assert.equal(runExtension(d,{amount:1,priority:'普通'}).trace[0].matched,false);
  assert.throws(()=>runExtension(d,{checked:'false',amount:1,priority:'普通'}));
  d.fields.push({key:'day',label:'日期',type:'date',required:false});
  d.workflow.rules[0].when={field:'day',operator:'not_equals',value:'2026-02-30'};assert.throws(()=>validateDefinition(d));
});
test('definition and bounded internal workflow',()=>{
  assert.deepEqual(validateDefinition(copy()),exampleDefinition);
  const result=runExtension(copy(),{subject:'验收',amount:600,priority:'普通'});
  assert.equal(result.data.priority,'优先');assert.equal(result.external_effects,false);
  assert.equal(runExtension(copy(),{subject:'验收',amount:1,priority:'普通'}).data.priority,'普通');
});
test('reject arbitrary code, network tools, unknown properties and cross-resource inputs',()=>{
  for(const extra of [{code:'alert(1)'},{tenant_id:'other'},{permissions:['payment.refund']},{html:'<script/>'}])assert.throws(()=>validateDefinition({...copy(),...extra}));
  assert.throws(()=>runExtension(copy(),{subject:'x',amount:2,priority:'普通',tenant_id:'other'}));
  const d=copy();(d.workflow as any).trigger='message.received';assert.throws(()=>validateDefinition(d));
  const e=copy();(e.workflow.rules[0].then as any)={url:'https://example.com',action:'http'};assert.throws(()=>validateDefinition(e));
});
test('reserved keys, duplicate fields and bad references fail closed',()=>{
  for(const key of ['__proto__','constructor','tenant_id','id','a.b']){const d=copy();d.fields[0].key=key;assert.throws(()=>validateDefinition(d));}
  const d=copy();d.fields.push(d.fields[0]);assert.throws(()=>validateDefinition(d));
  const e=copy();e.workflow.rules[0].when.field='secret';assert.throws(()=>validateDefinition(e));
  assert.throws(()=>validateDefinition(JSON.parse('{"__proto__":{}}')));
});
test('types, select options and size bounds enforced server-side',()=>{
  assert.throws(()=>runExtension(copy(),{subject:'x',amount:'600',priority:'普通'}));
  assert.throws(()=>runExtension(copy(),{subject:'x',amount:NaN,priority:'普通'}));
  assert.throws(()=>runExtension(copy(),{subject:'x',amount:600,priority:'invalid'}));
  assert.throws(()=>runExtension(copy(),{amount:600,priority:'普通'}));
  const d=copy();d.workflow.rules=Array(9).fill(d.workflow.rules[0]);assert.throws(()=>validateDefinition(d));
  const e=copy();e.workflow.rules[0].then.value='invalid';assert.throws(()=>validateDefinition(e));
});
test('renderable strings are data, not executable; hashes stable',()=>{
  const d=copy();d.page.title='<script>alert(1)</script>';assert.equal(validateDefinition(d).page.title,d.page.title);
  assert.equal(definitionHash(copy()),definitionHash(copy()));
});
test('rules read original input, no self triggering',()=>{
  const d=copy();d.workflow.rules.push({name:'第二条',when:{field:'priority',operator:'equals',value:'优先'},then:{field:'subject',value:'不应执行'}});
  assert.equal(runExtension(d,{subject:'原始',amount:600,priority:'普通'}).data.subject,'原始');
});
test('only real tenant admin console sessions manage extensions',()=>{
  const auth={auth_kind:'console_session',role:'tenant_admin',session_scope:'console',impersonation_id:null};
  assert.equal(canManageExtensions(auth),true);
  for(const changes of [{role:'agent'},{role:'supervisor'},{auth_kind:'api_key'},{session_scope:'copilot_embed'},{impersonation_id:'imp'}])assert.equal(canManageExtensions({...auth,...changes}),false);
});
