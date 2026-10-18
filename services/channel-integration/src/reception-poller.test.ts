import test from 'node:test';
import assert from 'node:assert/strict';
import {startReceptionPoller} from './reception-poller.js';
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(event:()=>Promise<boolean>){
  const ticks:Array<()=>void>=[];let enabled=true,cancelled=0,errors=0;
  const stop=startReceptionPoller({event,draft:async()=>{},discover:async()=>{},metrics:async()=>({})},{
    enabled:()=>enabled,schedule:(tick)=>{ticks.push(tick);return ()=>{cancelled++;};},
    report:(_kind,error)=>{if(error)errors++;}
  });
  return {ticks,stop,disable:()=>{enabled=false;},get cancelled(){return cancelled;},get errors(){return errors;}};
}
test('single-flight event polling caps each batch at ten',async()=>{
  let count=0;let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const f=fixture(async()=>{count++;if(count===1)await gate;return true;});
  f.ticks[0]!();await flush();f.ticks[0]!();await flush();assert.equal(count,1);
  release();await flush();assert.equal(count,10);await f.stop();assert.equal(f.cancelled,4);
});
test('disabled switch is checked between event claims',async()=>{
  let count=0;const f=fixture(async()=>{count++;f.disable();return true;});
  f.ticks[0]!();await flush();assert.equal(count,1);f.ticks[0]!();await flush();assert.equal(count,1);await f.stop();
});
test('polling resumes after a rejected task and stops cleanly',async()=>{
  let count=0;const f=fixture(async()=>{count++;if(count===1)throw new Error('synthetic');return false;});
  f.ticks[0]!();await flush();assert.equal(f.errors,1);
  f.ticks[0]!();await flush();assert.equal(count,2);
  await f.stop();f.ticks[0]!();await flush();assert.equal(count,2);
});
test('stop drains an in-flight call without claiming another event',async()=>{
  let release!:()=>void,count=0;const gate=new Promise<void>(r=>{release=r;});
  const f=fixture(async()=>{count++;await gate;return true;});f.ticks[0]!();await flush();
  let drained=false;const stopping=f.stop().then(()=>{drained=true;});await flush();assert.equal(drained,false);
  release();await stopping;assert.equal(count,1);assert.equal(drained,true);
});
