import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import {createMeteredAutomaticSemanticVerifier,recoverAutomaticSemanticVerifications,automaticSemanticPolicyAllowed} from './automatic-knowledge-verification.js';
import type {AutomaticGenerationPorts} from './automatic-reception-generation.js';
import {currentAutomaticGenerationLease} from './automatic-reception-generation-lease.js';
const forbidden=async():Promise<never>=>{throw Error('must_not_reach_data_or_model');};
const db={query:forbidden,connect:forbidden} as unknown as Pick<Pool,'query'|'connect'>;
const lease={} as AutomaticReceptionLease;
const ports:AutomaticGenerationPorts={enabled:()=>true,configured:()=>true,pointsEnabled:()=>true,reserve:forbidden,settle:forbidden,model:forbidden};
test('generation cannot reopen submitting or terminal work; final evidence requires explicit submitting phase',async()=>{
 const l={...lease,channel:'web_chat'} as AutomaticReceptionLease;
 for(const state of ['processing','submitting','sent','failed','draft','uncertain']){
  const c={query:async(sql:string,values:unknown[])=>{
   assert.match(sql,/j\.state=\$12/);assert.match(sql,/j\.worker_token=\$3/);
   assert.match(sql,/locked_at>NOW\(\)-INTERVAL '2 minutes'/);
   return {rowCount:values[11]===state?1:0,rows:[]};
  }} as unknown as Parameters<typeof currentAutomaticGenerationLease>[0];
  assert.equal(await currentAutomaticGenerationLease(c,l,'需要哪些材料？'),state==='processing');
  assert.equal(await currentAutomaticGenerationLease(c,l,'需要哪些材料？','send'),state==='submitting');
 }
 assert.equal(await currentAutomaticGenerationLease({query:forbidden} as never,l,'需要哪些材料？','invalid' as never),false);
});
test('disabled verifier, billing or model configuration does not touch data or model',async()=>{
 for(const gate of ['enabled','pointsEnabled','configured'])
  assert.equal(await createMeteredAutomaticSemanticVerifier(db,{...ports,[gate]:()=>false})(lease,'需要哪些材料？',{text:'说明',claims:[]}),false);
});
test('risky/ambiguous questions and unsafe answer do not reach verification billing',async()=>{
 const verify=createMeteredAutomaticSemanticVerifier(db,ports);
 for(const q of ['退款怎么处理？','发货和营业时间？','你好'])assert.equal(await verify(lease,q,{text:'说明',claims:[]}),false);
 assert.equal(await verify(lease,'需要哪些材料？',{text:'保证所有人都能完成。',claims:[]}),false);
});
test('semantic policy cannot hide a source overflow, foreign policy or missing business context',()=>{
 const base={tenantId:'a',channel:'web_chat' as const,question:'需要哪些材料？',now:new Date(),evidenceRevision:'1',sources:[],policies:[],sourceOverflow:false,policyOverflow:false};
 assert.equal(automaticSemanticPolicyAllowed(base),true);
 assert.equal(automaticSemanticPolicyAllowed({...base,sourceOverflow:true}),false);
 assert.equal(automaticSemanticPolicyAllowed({...base,policyOverflow:true}),false);
 const policy={tenantId:'a',policyId:'p',priority:1,scope:{},conditions:{},decision:{},requiresHumanApproval:false,forbiddenActions:[],timeBasis:'request_time'};
 for(const changed of [{tenantId:'b'},{conditions:{product:'x'}},{decision:{required:'manual'}},{requiresHumanApproval:true},{forbiddenActions:['send_message']}])
  assert.equal(automaticSemanticPolicyAllowed({...base,policies:[{...policy,...changed}]}),false);
});
test('verification recovery is bounded, excludes active calls and never creates model retries',async()=>{
 for(const before of [new Date(),new Date(NaN),new Date(Date.now()+600000)])await assert.rejects(()=>recoverAutomaticSemanticVerifications(db,before),/invalid_automatic/);
 for(const limit of [0,101,1.5])await assert.rejects(()=>recoverAutomaticSemanticVerifications(db,new Date(Date.now()-600000),limit),/invalid_automatic/);
});
