import test from 'node:test';
import assert from 'node:assert/strict';
import {createCustomerInsightsSources} from './customer-insights-sources.js';

const grant='bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const row={tenant_id:'fixture',account_id:'1',inbox_id:'4',conversation_id:'10',message_id:'100',grant_id:grant,generation:1,
 occurred_at:'2026-10-11T02:00:00.000Z',cutoff:'2026-10-11T01:00:00.000000Z',current_time:'2026-10-11T03:00:00.000000Z'};
test('default-off source completion hooks and recovery perform zero I/O',async()=>{
 let calls=0;const query=async()=>{calls++;throw Error('unexpected database');};
 const s=createCustomerInsightsSources({query,connect:query} as any,{admit:query} as any);
 await s.hooks.independent({query} as any,'invalid');await s.hooks.shared({query} as any,'','');assert.equal(await s.pump(),0);assert.equal(await s.recover(),0);await s.stop();assert.equal(calls,0);
});
test('separate shared gate stays closed and stopping suppresses trusted hooks',async()=>{
 let calls=0;const query=async()=>{calls++;throw Error('unexpected database');};
 const s=createCustomerInsightsSources({query,connect:query} as any,{admit:query} as any,{enabled:()=>true});
 await s.hooks.shared({query} as any,'app','receipt');await s.stop();await s.hooks.independent({query} as any,'1');assert.equal(calls,0);
});
test('exact receipt IDs only; invalid identifiers never hit a database',async()=>{
 let calls=0;const query=async()=>{calls++;throw Error('unexpected database');};
 const s=createCustomerInsightsSources({query,connect:query} as any,{admit:query} as any,{enabled:()=>true,sharedEnabled:()=>true});
 for(const key of ['0','-1','9223372036854775808','1;DELETE'])await assert.rejects(s.hooks.independent({query} as any,key),/invalid/);
 await assert.rejects(s.hooks.shared({query} as any,'app\n','event'),/invalid/);assert.equal(calls,0);await s.stop();
});
test('canonical time, microsecond consent boundary, scope and duplicate receipts are fail closed',async()=>{
 for(const change of [{occurred_at:'invalid'},{occurred_at:'2026-02-30T01:00:00.000Z'},{occurred_at:'2026-10-11T03:00:00.001Z'},
  {cutoff:'2026-10-11T02:00:00.000001Z'},{current_time:'invalid'},{message_id:'9223372036854775808'}]){
  let inserts=0;const query=async(sql:string)=>{if(sql.startsWith('INSERT'))inserts++;return {rows:[{...row,...change}]};};
  const s=createCustomerInsightsSources({} as any,{} as any,{enabled:()=>true});await s.hooks.independent({query} as any,'1');assert.equal(inserts,0);await s.stop();
 }
 const s=createCustomerInsightsSources({} as any,{} as any,{enabled:()=>true});await assert.rejects(s.hooks.independent({query:async()=>({rows:[row,row]})} as any,'1'),/ambiguous/);await s.stop();
});
test('closing during canonical receipt read prevents an insert',async()=>{
 let enabled=true,inserts=0;const query=async(sql:string)=>{if(sql.startsWith('INSERT'))inserts++;else enabled=false;return {rows:[row]};};
 const s=createCustomerInsightsSources({} as any,{} as any,{enabled:()=>enabled});await s.hooks.independent({query} as any,'1');assert.equal(inserts,0);await s.stop();
});
test('capture stores grant and receipt digest, never text/openid/payload',async()=>{
 const saved:{sql:string;args:unknown[]}[]=[];const query=async(sql:string,args:unknown[])=>{saved.push({sql,args});return {rows:[row]};};
 const s=createCustomerInsightsSources({} as any,{} as any,{enabled:()=>true});await s.hooks.independent({query} as any,'1');assert.equal(saved.length,2);
 const insert=saved[1];assert.match(insert.sql,/ON CONFLICT DO NOTHING/);assert.deepEqual(insert.args.slice(0,8),['fixture','1','4','10','100',grant,1,'independent']);assert.match(String(insert.args[8]),/^[a-f0-9]{64}$/);await s.stop();
});
test('metadata pump is bounded, single-flight and shutdown drains admission',async()=>{
 let claimed=0,finished=0,release=()=>{},admitted=0;
 const db={connect:async()=>({release:()=>{},query:async(sql:string)=>{
  if(sql.includes('WITH next AS')){claimed++;return {rows:[row]};}if(sql.startsWith('UPDATE customer_insight_sources'))finished++;return {rows:[]};
 }})};
 const s=createCustomerInsightsSources(db as any,{admit:async()=>{admitted++;await new Promise<void>(r=>{release=r;});return 'queued';}} as any,{enabled:()=>true});
 const p=s.pump();while(!admitted)await new Promise(r=>setImmediate(r));assert.equal(await s.pump(),0);
 let drained=false;const stop=s.stop().then(()=>{drained=true;});await new Promise(r=>setImmediate(r));assert.equal(drained,false);release();assert.equal(await p,1);await stop;
 assert.equal(claimed,1);assert.equal(finished,1);assert.equal(await s.pump(),0);
 const bounded=createCustomerInsightsSources(db as any,{admit:async()=> 'ignored'} as any,{enabled:()=>true});assert.equal(await bounded.pump(),20);await bounded.stop();assert.equal(claimed,21);
});
