import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustomerInsightsLifecycle} from './customer-insights-lifecycle.js';

function fixture(){const state={enabled:true,intake:0,model:0,recover:0,scheduled:0,canceled:0,callback:()=>{},hook:async()=>{}};
 const lifecycle=createCustomerInsightsLifecycle({enabled:()=>state.enabled,intake:async()=>{state.intake++;await state.hook();return true;},generate:async()=>{state.model++;return true;},recover:async()=>{state.recover++;},
  schedule:(callback,ms)=>{assert.ok([1000,10000].includes(ms));state.scheduled++;state.callback=callback;return ()=>{state.canceled++;};},report:()=>{throw Error('synthetic_diagnostic_failure');}});
 return {state,lifecycle};}
test('default-off lifecycle performs no I/O or scheduling',async()=>{
 let calls=0;const l=createCustomerInsightsLifecycle({intake:async()=>{calls++;return true;},generate:async()=>{calls++;return true;},recover:async()=>{calls++;},schedule:()=>{calls++;return ()=>{};}});
 l.start();assert.equal(await l.tick(),0);await l.stop();assert.equal(calls,0);
});
test('a pass is bounded to four metadata verifications and one generation',async()=>{
 const {state,lifecycle}=fixture();assert.equal(await lifecycle.tick(),5);assert.equal(state.intake,4);assert.equal(state.model,1);assert.equal(state.recover,1);
 assert.equal(await lifecycle.tick(),5);assert.equal(state.recover,1);await lifecycle.stop();
});
test('parallel ticks share no duplicate pass and stop drains actual in-flight work',async()=>{
 const {state,lifecycle}=fixture();let release=()=>{};state.hook=()=>new Promise<void>(r=>{release=r;});const pending=lifecycle.tick();
 while(!state.intake)await new Promise(r=>setImmediate(r));assert.equal(await lifecycle.tick(),0);
 let drained=false;const drain=lifecycle.stop().then(()=>{drained=true;});await new Promise(r=>setImmediate(r));assert.equal(drained,false);release();
 assert.equal(await pending,1);await drain;assert.equal(state.model,0);assert.equal(state.intake,1);assert.equal(await lifecycle.tick(),0);assert.throws(()=>lifecycle.start(),/stopped/);
});
test('repeated start creates one timer; cancellation cannot restart the loop',async()=>{
 const {state,lifecycle}=fixture();lifecycle.start();lifecycle.start();assert.equal(state.scheduled,1);await lifecycle.stop();assert.equal(state.canceled,1);
 state.callback();await new Promise(r=>setImmediate(r));assert.equal(state.scheduled,1);assert.equal(state.intake,0);assert.equal(state.model,0);
});
test('scheduled errors and failing diagnostics stay generic and do not break later timers',async()=>{
 const {state,lifecycle}=fixture();state.hook=async()=>{throw Error('synthetic_failure');};lifecycle.start();state.callback();await new Promise(r=>setImmediate(r));
 assert.equal(state.scheduled,2);assert.equal(state.model,0);await lifecycle.stop();
});
test('empty intake does not loop and a disabled flag stops before generation',async()=>{
 let reads=0,models=0,enabled=true;const l=createCustomerInsightsLifecycle({enabled:()=>enabled,recover:async()=>{},intake:async()=>{reads++;enabled=false;return false;},generate:async()=>{models++;return true;}});
 assert.equal(await l.tick(),0);assert.equal(reads,1);assert.equal(models,0);await l.stop();
});
test('receipt discovery precedes native verification; stop drains discovery without starting reads',async()=>{
 let release=()=>{},discover=0,reads=0;
 const l=createCustomerInsightsLifecycle({enabled:()=>true,recover:async()=>{},discover:async()=>{discover++;await new Promise<void>(r=>{release=r;});return 1;},
  intake:async()=>{reads++;return true;},generate:async()=>{throw Error('generation after stop');}});
 const p=l.tick();while(!discover)await new Promise(r=>setImmediate(r));let drained=false;const stop=l.stop().then(()=>{drained=true;});await new Promise(r=>setImmediate(r));assert.equal(drained,false);
 release();assert.equal(await p,1);await stop;assert.equal(reads,0);
});
