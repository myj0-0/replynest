import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAutomaticWeChatHistoryWorker} from './automatic-wechat-history-worker.js';
import {sealAutomaticWeChatEnvelope} from './automatic-wechat-history-envelope.js';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
const secret='isolated-history-worker-key-000000000000';
const uuid='aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const l:AutomaticReceptionLease={jobId:uuid,tenantId:'tenant-A',workerToken:uuid,channel:'shared_wechat',accountId:'1',conversationId:'2',
 messageId:'3',customerId:uuid,connectionId:null,authorizationId:uuid,consentVersion:'automatic-send-v1'};
const content='【旧商家】\n已发送的回复。',target={accountId:'1',customerId:uuid,conversationId:'2',inboxId:'4',contactId:'5',provider:'shared_wechat' as const,
 authorizationAt:'2026-10-02T00:00:00.000Z',sourceOccurredAt:'2026-10-02T00:01:00.000Z',sourceEventId:'verified-source',contactIdentifier:'rn_shared_'+'a'.repeat(64)};
function fixture(attempts=1,patch:any={}){
 const h={job_id:uuid,tenant_id:l.tenantId,send_worker_token:uuid,history_worker_token:uuid,attempts};
 const row={job_id:uuid,tenant_id:l.tenantId,worker_token:uuid,channel:l.channel,account_id:l.accountId,conversation_id:l.conversationId,
  message_id:l.messageId,customer_id:l.customerId,connection_id:null,authorization_id:uuid,consent_version:l.consentVersion,
  ...sealAutomaticWeChatEnvelope(l,target,content,secret),content_sha256:createHash('sha256').update(content).digest('hex'),
  provider_accepted_at:'2026-10-02T00:02:00.000123Z',...patch};
 const calls:{sql:string;values:any[]}[]=[];let transactions=0;
 const db={connect:async()=>({query:async(sql:string,values:any[]=[])=>{
  calls.push({sql,values});if(sql==='BEGIN')transactions++;if(sql==='COMMIT'||sql==='ROLLBACK')transactions--;
  if(sql.startsWith('WITH candidate'))return {rows:[h]};
  if(sql.startsWith('SELECT j.*'))return {rows:[row]};
  return {rows:[],rowCount:1};},release:()=>{}})} as any;
 return {db,calls,transactions:()=>transactions};
}
test('history worker defaults off with zero database and external I/O',async()=>{
 const db={connect:async()=>{assert.fail('no DB');}} as any;
 const w=createAutomaticWeChatHistoryWorker(db,{origin:'http://isolated.invalid',secret,native:{project:async()=>{assert.fail('no RPC');}}});
 assert.equal(await w.tick(),0);const p=w.stop();assert.strictEqual(w.stop(),p);await p;assert.equal(await w.tick(),0);
});
test('recording-only worker preserves historical body and microseconds outside database transaction',async()=>{
 const f=fixture();let calls=0;
 const w=createAutomaticWeChatHistoryWorker(f.db,{origin:'http://isolated.invalid',secret,enabled:()=>true,native:{project:async r=>{
  calls++;assert.equal(f.transactions(),0);assert.deepEqual(r,{target,messageId:'3',commandId:uuid,content,providerAcceptedAt:'2026-10-02T00:02:00.000123Z'});
  return {outcome:'recorded',messageId:'9007199254740993'};}}});
 assert.equal(await w.tick(),1);assert.equal(calls,1);
 const finish=f.calls.at(-2)!;assert.equal(finish.values[3],'recorded');assert.equal(finish.values[5],'9007199254740993');
 assert.match(finish.sql,/history_worker_token=\$3.*state='processing'/s);await w.stop();
});
test('uncertain history uses bounded backoff, never a send retry; terminal failure is capped at twelve attempts',async()=>{
 for(const attempts of [1,11,12]){
  const f=fixture(attempts);const w=createAutomaticWeChatHistoryWorker(f.db,{origin:'http://isolated.invalid',secret,enabled:()=>true,
   native:{project:async()=>{throw Error('private original reply');}}});
  await w.tick();const v=f.calls.at(-2)!.values;
  assert.equal(v[3],attempts<12?'pending':'failed');assert.equal(v[4],attempts<12?null:'history_unconfirmed');
  assert.ok(v[6]<=300);assert.equal(v[9-1],attempts);await w.stop();
 }
});
test('missing/corrupt/deleted journal or mismatched acknowledgement refuses native RPC',async()=>{
 for(const patch of [{ciphertext:null},{content_sha256:'a'.repeat(64)},{worker_token:'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb'}]){
  const f=fixture(1,patch);const w=createAutomaticWeChatHistoryWorker(f.db,{origin:'http://isolated.invalid',secret,enabled:()=>true,
   native:{project:async()=>{assert.fail('must not regenerate/rewrite missing history');}}});
  await w.tick();assert.equal(f.calls.at(-2)!.values[4],'history_envelope_unavailable');await w.stop();
 }
});
test('single-flight and stop drain an active native acknowledgement without another message',async()=>{
 const f=fixture();let release!:(v:any)=>void,calls=0;
 const w=createAutomaticWeChatHistoryWorker(f.db,{origin:'http://isolated.invalid',secret,enabled:()=>true,native:{project:async()=>{
  calls++;return new Promise(r=>{release=r;});}}});
 const active=w.tick();assert.equal(await w.tick(),0);while(!release)await new Promise(r=>setImmediate(r));
 let stopped=false;const stop=w.stop().then(()=>{stopped=true;});await new Promise(r=>setImmediate(r));assert.equal(stopped,false);
 release({outcome:'recorded',messageId:'6'});await active;await stop;assert.equal(await w.tick(),0);assert.equal(calls,1);
});
