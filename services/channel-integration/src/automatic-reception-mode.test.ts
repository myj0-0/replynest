import test from 'node:test';
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {automaticModeGuard,revokeAutomaticGrantForMode,writeAutomaticReceptionMode} from './automatic-reception-mode.js';

test('legacy mode changes need no automatic schema, but use the same advisory lock',async()=>{
 const sql:string[]=[];
 const c={query:async(q:string)=>{sql.push(q);return {rows:[{installed:false}]};}} as unknown as PoolClient;
 assert.equal(await revokeAutomaticGrantForMode(c,'tenant','actor'),null);
 assert.equal(sql.length,2);assert.match(sql[0],/advisory_xact_lock/);assert.match(sql[1],/to_regclass/);
});
test('mode change revokes grant before settings and replaces the authorization instance',async()=>{
 const calls:{q:string;p:unknown[]}[]=[];
 const c={query:async(q:string,p:unknown[]=[])=>{calls.push({q,p});return {rows:q.includes('to_regclass')?[{installed:true}]:q.includes('FOR UPDATE')?[{enabled:true,authorization_id:'old'}]:[]};}} as unknown as PoolClient;
 const r=await revokeAutomaticGrantForMode(c,'tenant','actor');
 assert.equal(r?.previous_authorization_id,'old');assert.notEqual(r?.authorization_id,'old');
 assert.match(calls[2].q,/FOR UPDATE/);assert.match(calls[3].q,/enabled=false/);
 assert.deepEqual(calls[3].p,['tenant',r?.authorization_id,'actor']);assert.ok(calls.every(v=>!v.q.includes('tenant_ai_settings')));
});
test('grant enabled/disabled selects automatic/manual atomically without changing model settings',async()=>{
 const calls:{q:string;p:unknown[]}[]=[];
 const c={query:async(q:string,p:unknown[])=>{calls.push({q,p});return {rows:[{}]};}} as unknown as PoolClient;
 await writeAutomaticReceptionMode(c,'tenant','actor',true);await writeAutomaticReceptionMode(c,'tenant','actor',false);
 assert.deepEqual(calls[0].p,['tenant','actor',true,'automatic-reply-v1']);assert.deepEqual(calls[1].p,['tenant','actor',false,null]);
 assert.match(calls[0].q,/ON CONFLICT/);assert.ok(!calls[0].q.includes('llm_model'));
 assert.match(automaticModeGuard,/s\.ai_auto_reply_enabled/);assert.match(automaticModeGuard,/s\.automatic_sending_enabled/);assert.match(automaticModeGuard,/automatic-reply-v1/);
});
