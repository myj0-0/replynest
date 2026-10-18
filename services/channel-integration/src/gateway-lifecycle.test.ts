import test from 'node:test';
import assert from 'node:assert/strict';
import {createGatewayLifecycle} from './gateway-lifecycle.js';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
test('stop cancels every scheduler immediately and drains observed work exactly once',async()=>{
 const l=createGatewayLifecycle(),gate=deferred(),started=deferred(),cancelled:number[]=[];
 const work=l.run(async()=>{started.resolve();await gate.promise;});await started.promise;
 l.register(()=>{cancelled.push(1);return gate.promise;});l.register(()=>{cancelled.push(2);});
 const drain=l.stop();assert.strictEqual(l.stop(),drain);assert.equal(l.stopping,true);assert.deepEqual(cancelled,[1,2]);
 let done=false;void drain.then(()=>{done=true;});await new Promise(r=>setImmediate(r));assert.equal(done,false);
 await assert.rejects(l.run(()=>{throw Error('must not run');}),/gateway_stopping/);assert.throws(()=>l.register(()=>{}),/gateway_stopping/);
 gate.resolve();await work;await drain;assert.equal(done,true);
});
test('scheduled-but-not-started microtask cannot run after stop',async()=>{
 const l=createGatewayLifecycle();let calls=0;const p=l.run(()=>{calls++;});const stop=l.stop();
 await assert.rejects(p,/gateway_stopping/);await stop;assert.equal(calls,0);
});
test('failed work remains visible to its caller but does not prevent a successful drain',async()=>{
 const l=createGatewayLifecycle(),gate=deferred(),started=deferred();
 const p=l.run(async()=>{started.resolve();await gate.promise;throw Error('fixed work failure');});await started.promise;
 const observed=assert.rejects(p,/fixed work failure/),stop=l.stop();gate.resolve();await observed;await stop;
});
test('failed cancellation still invokes remaining stops and reports a fixed error',async()=>{
 const l=createGatewayLifecycle();let calls=0;l.register(()=>{throw Error('private detail');});l.register(()=>{calls++;});
 await assert.rejects(l.stop(),/^Error: gateway_stop_failed$/);assert.equal(calls,1);
});
test('real interval stops permanently and validates its delay',async()=>{
 const l=createGatewayLifecycle();let calls=0;
 for(const n of [0,-1,NaN,Infinity])assert.throws(()=>l.every(()=>{},n),/invalid_gateway_interval/);
 l.every(()=>{calls++;},5);await new Promise(r=>setTimeout(r,25));assert.ok(calls>0);await l.stop();const before=calls;
 await new Promise(r=>setTimeout(r,25));assert.equal(calls,before);assert.throws(()=>l.every(()=>{},5),/invalid_gateway_interval/);
});
