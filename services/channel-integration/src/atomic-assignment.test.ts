import test from 'node:test';import assert from 'node:assert/strict';import {createHmac} from 'node:crypto';
import {createAtomicAssignment,validSnapshot} from './atomic-assignment.js';
const snapshot={account_id:'7',conversation_id:'31',assignee_id:null,bot_id:null,status:'open',updated_at:'2026-09-25T10:00:00.123456Z'};
test('atomic adapter signs route and body; verifies boundaries and command receipts',async()=>{
 const secret='s'.repeat(32);let requests=0;
 const fake:typeof fetch=async(url,init)=>{requests++;const path=new URL(String(url)).pathname,h=init?.headers as Record<string,string>,raw=String(init?.body);
 assert.equal(init?.redirect,'error');assert.equal(h['x-assignment-signature'],createHmac('sha256',secret).update(`${path}\n${h['x-assignment-timestamp']}\n${h['x-assignment-nonce']}\n${raw}`).digest('hex'));
 return new Response(JSON.stringify(path.endsWith('snapshot')?{snapshot}:{command_id:JSON.parse(raw).command_id,state:'applied'}));};
 const api=createAtomicAssignment({baseUrl:'http://internal.test',secret},fake);assert.deepEqual(await api.snapshot('7','31'),snapshot);
 assert.equal((await api.assign({command_id:'test-command',account_id:'7',conversation_id:'31',target_user_id:'11',snapshot})).state,'applied');
 assert.equal((await api.receipt('7','test-command')).state,'applied');assert.equal(requests,3);
 await assert.rejects(api.snapshot('8','31'),/invalid_snapshot/);
});
test('bad snapshots, failed requests and mismatched receipts fail closed without retry',async()=>{
 assert.equal(validSnapshot({...snapshot,updated_at:'yesterday'}),false);assert.equal(validSnapshot({...snapshot,assignee_id:'other'}),false);
 let count=0;const api=createAtomicAssignment({baseUrl:'http://internal.test',secret:'s'.repeat(32)},async()=>{count++;throw Error('timeout');});
 await assert.rejects(api.receipt('7','x'));assert.equal(count,1);
 const bad=createAtomicAssignment({baseUrl:'http://internal.test',secret:'s'.repeat(32)},async()=>new Response(JSON.stringify({command_id:'different',state:'applied'})));
 await assert.rejects(bad.receipt('7','x'),/invalid_response/);
});
