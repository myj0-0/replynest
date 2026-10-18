import test from 'node:test';
import assert from 'node:assert/strict';
import {serializeAutomationClaim,claimAutomationPlan,planClaimPressure} from './automation-plan-queue.js';
test('local claims serialize in admission order and preserve caller results',async()=>{
 let active=0,max=0;const order:number[]=[];
 const values=await Promise.all(Array.from({length:4},(_,i)=>serializeAutomationClaim(async()=>{
  max=Math.max(max,++active);order.push(i);await new Promise(r=>setTimeout(r,5));active--;return i;
 })));
 assert.equal(max,1);assert.deepEqual(order,[0,1,2,3]);assert.deepEqual(values,[0,1,2,3]);
});
test('throwing claim releases local lane, does not suppress error or change pressure metrics',async()=>{
 const before=planClaimPressure.lockTimeouts;
 const results=await Promise.allSettled([serializeAutomationClaim(async()=>{throw Error('database_failure');}),serializeAutomationClaim(async()=>42)]);
 assert.equal(results[0].status,'rejected');assert.deepEqual(results[1],{status:'fulfilled',value:42});assert.equal(planClaimPressure.lockTimeouts,before);
});
test('global claim lock still enforces bounded timeout and is not replaced by local lock',async()=>{
 const calls:string[]=[];const before=planClaimPressure.lockTimeouts;
 const client={query:async(sql:string)=>{calls.push(sql);if(sql.includes('pg_advisory_xact_lock'))throw Object.assign(Error('lock busy'),{code:'55P03'});return {rows:[]};}};
 assert.equal(await claimAutomationPlan(client as never),undefined);
 assert.ok(calls.includes("SET LOCAL lock_timeout='500ms'"));assert.equal(calls.at(-1),'ROLLBACK');assert.equal(planClaimPressure.lockTimeouts,before+1);
});
test('row lock failure is still surfaced, not misclassified as harmless admission contention',async()=>{
 const client={query:async(sql:string)=>{if(sql.startsWith('UPDATE'))throw Object.assign(Error('row lock busy'),{code:'55P03'});return {rows:[]};}};
 await assert.rejects(()=>claimAutomationPlan(client as never),/row lock busy/);
});
