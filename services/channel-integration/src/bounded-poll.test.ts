import test from 'node:test';
import assert from 'node:assert/strict';
import {startBoundedPoll} from './bounded-poll.js';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test('busy poll continues without overlap and cancellation stops future invocations',async()=>{
 let count=0,active=0,peak=0;
 const stop=startBoundedPoll(async()=>{count++;active++;peak=Math.max(peak,active);await delay(20);active--;return {retrySoon:true};},()=>assert.fail('unexpected failure'));
 await delay(160);stop();const stoppedAt=count;
 await delay(100);assert.ok(count>=2);assert.equal(count,stoppedAt);assert.equal(peak,1);
});
test('failed poll backs off rather than spins',async()=>{
 let count=0,errors=0;
 const stop=startBoundedPoll(async()=>{count++;throw Error('synthetic');},()=>{errors++;});
 await delay(100);stop();assert.equal(count,1);assert.equal(errors,1);
});
