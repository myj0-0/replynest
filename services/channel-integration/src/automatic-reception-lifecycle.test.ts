import test from 'node:test';
import assert from 'node:assert/strict';
import {startAutomaticReceptionLifecycle} from './automatic-reception-lifecycle.js';
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('scheduler is default-off and does not create overlapping invocations',async()=>{
 const ticks:Array<()=>void>=[];let calls=0,cancelled=0;
 const stop=startAutomaticReceptionLifecycle({tick:async()=>{calls++;return 0;},stop:async()=>{}},{schedule:fn=>{ticks.push(fn);return ()=>{cancelled++;};}});
 ticks[0]!();await flush();assert.equal(calls,0);assert.equal(ticks.length,2);await stop();assert.equal(cancelled,1);
});
test('busy work schedules only after completion, errors back off and logs contain no error text',async()=>{
 const ticks:Array<()=>void>=[],delays:number[]=[],reports:unknown[]=[];let release!:()=>void,calls=0;
 const gate=new Promise<void>(r=>{release=r;});
 const stop=startAutomaticReceptionLifecycle({tick:async()=>{calls++;if(calls===1){await gate;return 11;}throw Error('private raw token');},stop:async()=>{}},
  {enabled:()=>true,schedule:(fn,ms)=>{ticks.push(fn);delays.push(ms);return ()=>{};},report:(state,count)=>reports.push({state,count})});
 ticks[0]!();await flush();assert.equal(ticks.length,1);release();await flush();assert.deepEqual(reports,[{state:'processed',count:10}]);
 ticks[1]!();await flush();assert.equal(delays.at(-1),10000);assert.ok(!JSON.stringify(reports).includes('token'));await stop();
});
test('shutdown cancels scheduling and waits for the active queue drain',async()=>{
 let fn!:()=>void,release!:()=>void,cancelled=0,draining=false;const gate=new Promise<void>(r=>{release=r;});
 const stop=startAutomaticReceptionLifecycle({tick:()=>gate.then(()=>1),stop:async()=>{draining=true;await gate;}},
  {enabled:()=>true,schedule:next=>{fn=next;return ()=>{cancelled++;};}});
 fn();await flush();let done=false;const stopped=stop().then(()=>{done=true;});await flush();assert.equal(draining,true);assert.equal(done,false);
 release();await stopped;assert.equal(cancelled,1);
});
test('fast due-loop polling is finite, server-owned and backs off without leaking failures',async()=>{
 const callbacks:Array<()=>void>=[],delays:number[]=[];
 const stop=startAutomaticReceptionLifecycle({tick:async()=>{throw Error('private');},stop:async()=>{}},{enabled:()=>true,intervalMs:500,
  schedule:(fn,ms)=>{callbacks.push(fn);delays.push(ms);return ()=>{};}});
 assert.deepEqual(delays,[500]);callbacks[0]!();await flush();assert.equal(delays.at(-1),10000);await stop();
 for(const intervalMs of [0,249,3001,NaN,500.5])assert.throws(()=>startAutomaticReceptionLifecycle({tick:async()=>0,stop:async()=>{}},{intervalMs}),/invalid/);
});
