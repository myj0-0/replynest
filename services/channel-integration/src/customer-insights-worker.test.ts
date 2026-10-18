import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustomerInsightsWorker,type InsightsPorts,type InsightJob} from './customer-insights-worker.js';
const job:InsightJob={tenantId:'a',accountId:'2',customerId:'bbbbbbbb-1111-4111-8111-aaaaaaaaaaaa',conversationId:'3',grantId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',generation:1,revision:0,jobId:'dddddddd-1111-4111-8111-aaaaaaaaaaaa',lease:'eeeeeeee-1111-4111-8111-aaaaaaaaaaaa'};
function fixture(){
 const state={enabled:true,authorized:true,claimed:false,reads:0,models:0,reservations:0,saves:0,budget:true,fence:true,states:[] as string[],settlements:[] as string[]};
 const ports:InsightsPorts={enabled:()=>state.enabled,claim:async()=>{if(state.claimed)return null;state.claimed=true;return job;},authorized:async()=>state.authorized,
  read:async()=>{state.reads++;return {rows:[{tenantId:'a',accountId:'2',customerId:job.customerId,conversationId:'3',messageId:'101',createdAt:'2026-10-11T01:00:00Z',direction:'incoming',author:'customer',private:false,text:'几天发货'}],previous:[],known:[]};},
  reserve:async()=>{state.reservations++;return state.budget?{ticket:'synthetic-ticket'}:null;},
  beginModel:async()=>state.authorized&&state.fence,
  model:async()=>{state.models++;return {text:JSON.stringify({long_term:[],current_issue:{text:'咨询发货时间',evidence_ids:['101']},topic:'shipping'}),usage:{input_tokens:100,output_tokens:50,cached_input_tokens:0}};},
  settle:async(_j,_ticket,_usage,outcome)=>{state.settlements.push(outcome);},save:async()=>{if(!state.fence)return false;state.saves++;return true;},finish:async(_j,outcome)=>{state.states.push(outcome);}};
 return {state,ports};
}
test('default-off or revoked purpose never reads or calls a model',async()=>{
 for(const disabled of [true,false]){const f=fixture();if(disabled)f.state.enabled=false;else f.state.authorized=false;await createCustomerInsightsWorker(f.ports).runOne();assert.equal(f.state.reads,0);assert.equal(f.state.models,0);}
});
test('one claimed job is metered once and saves only AI fields via the dedicated port',async()=>{
 const f=fixture(),worker=createCustomerInsightsWorker(f.ports);await Promise.all([worker.runOne(),worker.runOne()]);await worker.runOne();
 assert.equal(f.state.models,1);assert.equal(f.state.reservations,1);assert.equal(f.state.saves,1);assert.deepEqual(f.state.settlements,['known']);assert.deepEqual(f.state.states,['saved']);
});
test('provider receives the same strict source schema whose bytes were reserved; invalid output still rejected',async()=>{
 const f=fixture();let reserved:any,format:any;
 const reserve=f.ports.reserve;f.ports.reserve=async(j,input,max)=>{reserved=JSON.parse(input);return reserve(j,input,max);};
 const model=f.ports.model;f.ports.model=async(messages,max,schema)=>{format=schema;return model(messages,max,schema);};
 await createCustomerInsightsWorker(f.ports).runOne();assert.deepEqual(reserved.response_format,format);
 assert.equal(format.type,'json_schema');assert.deepEqual(format.json_schema.schema.properties.current_issue.properties.evidence_ids.items.enum,['101']);
 assert.ok(reserved.messages.some((m:{content:string})=>m.content.includes('101')));
 assert.equal(f.state.models,1);assert.equal(f.state.saves,1);assert.deepEqual(f.state.settlements,['known']);
});
test('budget exhaustion stops before provider call',async()=>{
 const f=fixture();f.state.budget=false;await createCustomerInsightsWorker(f.ports).runOne();assert.equal(f.state.models,0);assert.equal(f.state.saves,0);assert.deepEqual(f.state.states,['budget_exhausted']);
});
test('revocation before model releases only an unused reservation',async()=>{
 const f=fixture(),reserve=f.ports.reserve;f.ports.reserve=async(...args)=>{const r=await reserve(...args);f.state.authorized=false;return r;};
 await createCustomerInsightsWorker(f.ports).runOne();assert.equal(f.state.models,0);assert.deepEqual(f.state.settlements,['not_called']);assert.deepEqual(f.state.states,['revoked']);
});
test('revocation after model charges actual usage without publishing',async()=>{
 const f=fixture(),model=f.ports.model;f.ports.model=async(...args)=>{const r=await model(...args);f.state.authorized=false;return r;};
 await createCustomerInsightsWorker(f.ports).runOne();assert.equal(f.state.saves,0);assert.deepEqual(f.state.settlements,['known']);assert.deepEqual(f.state.states,['revoked']);
});
test('manual correction/deletion revision fence rejects an older generated result',async()=>{
 const f=fixture(),model=f.ports.model;f.ports.model=async(...args)=>{const r=await model(...args);f.state.fence=false;return r;};await createCustomerInsightsWorker(f.ports).runOne();assert.equal(f.state.saves,0);assert.deepEqual(f.state.settlements,['known']);assert.deepEqual(f.state.states,['revoked']);
});
test('durable calling fence rejects stale lease before spending provider tokens',async()=>{
 const f=fixture();f.ports.beginModel=async()=>false;await createCustomerInsightsWorker(f.ports).runOne();assert.equal(f.state.models,0);assert.deepEqual(f.state.settlements,['not_called']);
});
test('settlement interruption preserves known provider usage instead of converting it to unknown',async()=>{
 const f=fixture();let attempts=0;f.ports.settle=async(_j,_t,usage,state)=>{f.state.settlements.push(state);assert.equal(usage?.input_tokens,100);if(attempts++===0)throw Error('database_ack_lost');};
 await createCustomerInsightsWorker(f.ports).runOne();assert.equal(f.state.models,1);assert.equal(f.state.saves,0);assert.deepEqual(f.state.settlements,['known','known']);
});
test('malformed trusted job fails before chat read',async()=>{
 const f=fixture();f.ports.claim=async()=>({...job,tenantId:'bad/tenant'});await createCustomerInsightsWorker(f.ports).runOne();assert.equal(f.state.reads,0);assert.equal(f.state.models,0);
});
test('provider timeout stays uncertain with held budget; no automatic retry',async()=>{
 const f=fixture();f.ports.model=async()=>{f.state.models++;throw Error('timeout');};const worker=createCustomerInsightsWorker(f.ports);
 await worker.runOne();await worker.runOne();assert.equal(f.state.models,1);assert.deepEqual(f.state.settlements,['unknown']);assert.deepEqual(f.state.states,['uncertain']);
});
test('invalid AI output still consumes actual tokens but cannot overwrite notes',async()=>{
 const f=fixture();f.ports.model=async()=>({text:'{"note":"overwrite human text"}',usage:{input_tokens:100,output_tokens:50,cached_input_tokens:0}});
 await createCustomerInsightsWorker(f.ports).runOne();assert.equal(f.state.saves,0);assert.deepEqual(f.state.settlements,['known']);assert.deepEqual(f.state.states,['rejected']);
});

test('output rejection reports only a fixed structural reason and never retries a charged call',async()=>{
 const f=fixture(),failures:unknown[]=[];f.ports.reportFailure=v=>failures.push(v);
 f.ports.model=async()=>{f.state.models++;return {text:JSON.stringify({long_term:[],current_issue:{text:'private provider phrase',evidence_ids:[101]},topic:'shipping'}),usage:{input_tokens:100,output_tokens:50,cached_input_tokens:0}};};
 const worker=createCustomerInsightsWorker(f.ports);await worker.runOne();await worker.runOne();
 assert.deepEqual(failures,[{phase:'output',code:'output_evidence_type'}]);assert.equal(f.state.models,1);assert.equal(f.state.saves,0);
 assert.deepEqual(f.state.settlements,['known']);assert.deepEqual(f.state.states,['rejected']);
});

test('storage diagnostics do not expose SQL text or affect actual cost settlement',async()=>{
 const f=fixture(),failures:unknown[]=[];f.ports.reportFailure=v=>failures.push(v);
 f.ports.save=async()=>{throw Object.assign(Error('private SQL and secret value'),{code:'42501'});};
 await createCustomerInsightsWorker(f.ports).runOne();assert.deepEqual(failures,[{phase:'save',code:'storage_permission'}]);
 assert.deepEqual(f.state.settlements,['known']);assert.deepEqual(f.state.states,['rejected']);
});

test('failing diagnostic sink cannot cause model replay or skip terminal settlement',async()=>{
 const f=fixture();f.ports.reportFailure=()=>{throw Error('sink failed');};
 f.ports.model=async()=>{f.state.models++;throw Error('private URL and key');};
 const worker=createCustomerInsightsWorker(f.ports);await worker.runOne();await worker.runOne();
 assert.equal(f.state.models,1);assert.deepEqual(f.state.settlements,['unknown']);assert.deepEqual(f.state.states,['uncertain']);
});
test('proven empty batch uses a fenced progress commit without reserving points or calling model',async()=>{
 const f=fixture();f.ports.read=async()=>({rows:[],previous:[],known:[]});let skipped=0;f.ports.skipBatch=async()=>{skipped++;return true;};
 await createCustomerInsightsWorker(f.ports).runOne();assert.equal(skipped,1);assert.equal(f.state.models,0);assert.equal(f.state.reservations,0);assert.deepEqual(f.state.settlements,[]);
});
