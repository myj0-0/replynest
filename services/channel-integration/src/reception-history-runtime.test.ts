import test from 'node:test';
import assert from 'node:assert/strict';
import {createReceptionHistoryQueueRuntime,validateReceptionHistoryStartup,validateReceptionDraftPresentationStartup} from './reception-history-runtime.js';
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const env={AI_RECEPTION_HISTORY_READ_ENABLED:'true',AI_RECEPTION_PERSONALIZATION_MANAGEMENT_ENABLED:'true',
 AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED:'true',DATABASE_STARTUP_MODE:'verify',CHATWOOT_BASE_URL:'http://fixture-native:3000',
 AI_HISTORY_KNOWLEDGE_DRAFTS_ENABLED:'true',AI_POINTS_ENABLED:'true'};
test('draft presentation/context startup rejects implicit consent, invalid flags and legacy DDL startup',()=>{
 assert.deepEqual(validateReceptionDraftPresentationStartup({}),{draft:false,context:false,automatic:false});
 assert.throws(()=>validateReceptionDraftPresentationStartup({AI_RECEPTION_HISTORY_CONTEXT_ENABLED:'true'}),/dependencies/);
 assert.throws(()=>validateReceptionDraftPresentationStartup({AI_RECEPTION_DRAFT_PRESENTATION_ENABLED:'yes'}),/flag_invalid/);
 for(const key of ['DATABASE_STARTUP_MODE','AI_RECEPTION_PERSONALIZATION_MANAGEMENT_ENABLED','AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED'])
  assert.throws(()=>validateReceptionDraftPresentationStartup({...env,AI_RECEPTION_DRAFT_PRESENTATION_ENABLED:'true',[key]:'false'}),/verified_management/);
 assert.deepEqual(validateReceptionDraftPresentationStartup({...env,AI_RECEPTION_DRAFT_PRESENTATION_ENABLED:'true',AI_RECEPTION_HISTORY_CONTEXT_ENABLED:'true'}),{draft:true,context:true,automatic:false});
});
test('automatic presentation requires the verified independent verifier and metering component',()=>{
 const automatic={...env,AI_RECEPTION_AUTOMATIC_PRESENTATION_ENABLED:'true',AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED:'true',AI_RECEPTION_HISTORY_CONTEXT_ENABLED:'true'};
 assert.deepEqual(validateReceptionDraftPresentationStartup(automatic),{draft:false,context:true,automatic:true});
 for(const name of ['AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED','AI_POINTS_ENABLED'])
  assert.throws(()=>validateReceptionDraftPresentationStartup({...automatic,[name]:'false'}),/verifier_required/);
 assert.throws(()=>validateReceptionDraftPresentationStartup({...automatic,DATABASE_STARTUP_MODE:'legacy'}),/verified_management/);
 assert.throws(()=>validateReceptionDraftPresentationStartup({...automatic,AI_RECEPTION_AUTOMATIC_PRESENTATION_ENABLED:'yes'}),/flag_invalid/);
});
test('default-off startup never reads a secret or model; enabling requires verify/purpose dependencies',()=>{
 const no=()=>{throw Error('must not access');};assert.equal(validateReceptionHistoryStartup({},no,no).read,false);
 for(const key of ['AI_RECEPTION_HISTORY_READ_ENABLED','AI_HISTORY_KNOWLEDGE_GENERATION_ENABLED','AI_RECEPTION_STYLE_LEARNING_ENABLED'])
  assert.throws(()=>validateReceptionHistoryStartup({[key]:'yes'},no,no),/flag_invalid/);
 assert.throws(()=>validateReceptionHistoryStartup({AI_RECEPTION_STYLE_LEARNING_ENABLED:'true'},no,no),/read_required/);
 for(const key of ['AI_RECEPTION_PERSONALIZATION_MANAGEMENT_ENABLED','AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED','DATABASE_STARTUP_MODE'])
  assert.throws(()=>validateReceptionHistoryStartup({...env,[key]:'false'},no,no),/verified_management/);
 for(const key of ['AI_HISTORY_KNOWLEDGE_DRAFTS_ENABLED','AI_POINTS_ENABLED'])
  assert.throws(()=>validateReceptionHistoryStartup({...env,AI_HISTORY_KNOWLEDGE_GENERATION_ENABLED:'true',[key]:'false'},no,no),/dependencies_required/);
});
test('style-only startup does not call the model; generation validates configuration without fetching',()=>{
 let models=0,keys=0;const key=(name:string)=>{assert.equal(name,'REPLYNEST_AUTOMATIC_REPLY_SECRET');keys++;return 'synthetic-'+ '0'.repeat(40);};
 const style=validateReceptionHistoryStartup({...env,AI_RECEPTION_STYLE_LEARNING_ENABLED:'true'},key,()=>{models++;});
 assert.equal(style.style,true);assert.equal(style.knowledge,false);assert.equal(models,0);assert.ok(Object.isFrozen(style));
 const gen=validateReceptionHistoryStartup({...env,AI_HISTORY_KNOWLEDGE_GENERATION_ENABLED:'true'},key,()=>{models++;});
 assert.equal(gen.knowledge,true);assert.equal(models,1);assert.equal(keys,2);
 for(const origin of ['https://x.invalid/a','https://user:password@x.invalid','https://x.invalid/?secret=a','ftp://x.invalid'])
  assert.throws(()=>validateReceptionHistoryStartup({...env,CHATWOOT_BASE_URL:origin},key,()=>{}),/configuration_invalid/);
 assert.throws(()=>validateReceptionHistoryStartup(env,()=> 'short',()=>{}),/configuration_invalid/);
 assert.throws(()=>validateReceptionHistoryStartup({...env,AI_HISTORY_KNOWLEDGE_GENERATION_ENABLED:'true'},key,()=>{throw Error('private key detail');}),/^Error: reception_history_configuration_invalid$/);
});
test('default-off runtime performs no scheduling, DB or provider work; start is idempotent',async()=>{
 let scheduled=0,calls=0;const runtime=createReceptionHistoryQueueRuntime({knowledge:{runOne:async()=>{calls++;return {state:'succeeded'};}},
  schedule:()=>{scheduled++;return ()=>{};}});runtime.start();runtime.start();await flush();assert.equal(scheduled,0);assert.equal(calls,0);
 await runtime.stop();assert.throws(()=>runtime.start(),/stopping/);
});
test('one knowledge job at a time; failed/uncertain jobs are not retried by the scheduler',async()=>{
 const ticks:Array<()=>void>=[],delays:number[]=[],reports:unknown[]=[];let calls=0,release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const runtime=createReceptionHistoryQueueRuntime({enabled:()=>true,knowledge:{runOne:async()=>{calls++;await gate;return {state:'uncertain'};}},
  schedule:(fn,delay)=>{ticks.push(fn);delays.push(delay);return ()=>{};},report:(worker,state,count)=>reports.push({worker,state,count})});
 runtime.start();runtime.start();assert.equal(ticks.length,1);ticks[0]!();ticks[0]!();await flush();assert.equal(calls,1);assert.equal(ticks.length,1);
 release();await flush();assert.equal(ticks.length,2);assert.deepEqual(delays,[3000,3000]);
 assert.deepEqual(reports,[{worker:'knowledge',state:'processed',count:1}]);await runtime.stop();
});
test('style batches have fixed size/keyset, finish a sweep at empty page and never log source identifiers',async()=>{
 const ticks:Array<()=>void>=[],inputs:unknown[]=[],reports:unknown[]=[];
 const results=[{state:'processed' as const,scanned:5,nextTenant:'merchant-b'},{state:'processed' as const,scanned:0,nextTenant:null},
  {state:'processed' as const,scanned:1,nextTenant:'merchant-a'}];
 const runtime=createReceptionHistoryQueueRuntime({enabled:()=>true,style:{batch:async input=>{inputs.push(input);return results.shift()!;}},
  schedule:fn=>{ticks.push(fn);return ()=>{};},report:(worker,state,count)=>reports.push({worker,state,count})});
 runtime.start();for(let i=0;i<3;i++){ticks[i]!();await flush();}
 assert.deepEqual(inputs,[{limit:5},{limit:5,afterTenant:'merchant-b'},{limit:5}]);
 assert.equal(JSON.stringify(reports).includes('merchant'),false);await runtime.stop();
});
test('private exceptions and invalid batch responses back off without changing keyset or replaying jobs',async()=>{
 const ticks:Array<()=>void>=[],delays:number[]=[],reports:unknown[]=[];let calls=0;
 const runtime=createReceptionHistoryQueueRuntime({enabled:()=>true,knowledge:{runOne:async()=>{throw Error('private history content');}},
  style:{batch:async()=>{calls++;return {state:'processed',scanned:6,nextTenant:'secret-tenant'};}},
  schedule:(fn,delay)=>{ticks.push(fn);delays.push(delay);return ()=>{};},report:(worker,state,count)=>reports.push({worker,state,count})});
 runtime.start();ticks[0]!();ticks[1]!();await flush();assert.equal(calls,1);assert.deepEqual(delays,[3000,30000,10000,30000]);
 assert.deepEqual(reports,[{worker:'knowledge',state:'unavailable',count:0},{worker:'style',state:'unavailable',count:0}]);await runtime.stop();
});
test('shutdown cancels both schedulers immediately, blocks queued starts and drains active work',async()=>{
 let enabled=true,cancelled=0,release!:()=>void,done=false,calls=0;const ticks:Array<()=>void>=[];
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const runtime=createReceptionHistoryQueueRuntime({enabled:()=>enabled,knowledge:{runOne:async()=>{calls++;await gate;return {state:'succeeded'};}},
  style:{batch:async()=>({state:'processed',scanned:0,nextTenant:null})},schedule:fn=>{ticks.push(fn);return ()=>{cancelled++;};}});
 runtime.start();ticks[0]!();await flush();enabled=false;const stopping=runtime.stop().then(()=>{done=true;});
 ticks[1]!();await flush();assert.equal(done,false);assert.equal(cancelled,1);assert.equal(calls,1);
 release();await stopping;assert.equal(done,true);assert.equal(ticks.length,2);await runtime.stop();
});
test('report failures cannot crash unobserved work; cancellation failures still stop both loops with a fixed error',async()=>{
 const ticks:Array<()=>void>=[];let cancels=0;
 const runtime=createReceptionHistoryQueueRuntime({enabled:()=>true,knowledge:{runOne:async()=>({state:'succeeded'})},
  style:{batch:async()=>({state:'processed',scanned:0,nextTenant:null})},report:()=>{throw Error('private reporter exception');},
  schedule:fn=>{ticks.push(fn);return ()=>{cancels++;if(cancels===1)throw Error('private scheduler exception');};}});
 runtime.start();ticks[0]!();await flush();await assert.rejects(()=>runtime.stop(),/^Error: reception_history_stop_failed$/);
 assert.equal(cancels,2);assert.throws(()=>runtime.start(),/stopping/);
});
