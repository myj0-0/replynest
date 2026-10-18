import test from 'node:test';
import assert from 'node:assert/strict';
import {sealAutomaticWeChatEnvelope,openAutomaticWeChatEnvelope,persistAutomaticWeChatEnvelope} from './automatic-wechat-history-envelope.js';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import type {AutomaticWeChatNativeTarget} from './automatic-wechat-native-client.js';
const secret='isolated-envelope-key-0000000000000000';
const id=(n:string)=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const lease:AutomaticReceptionLease={jobId:id('a'),tenantId:'merchant-A',workerToken:id('b'),channel:'shared_wechat',
 accountId:'1',conversationId:'2',customerId:id('c'),messageId:'9007199254740993',connectionId:null,
 authorizationId:id('d'),consentVersion:'automatic-send-v1'};
const target:AutomaticWeChatNativeTarget={accountId:'1',customerId:lease.customerId,conversationId:'2',inboxId:'3',contactId:'4',provider:'shared_wechat',
 authorizationAt:'2026-10-02T00:00:00.000Z',sourceOccurredAt:'2026-10-02T00:01:00.000Z',sourceEventId:'verified-event',
 contactIdentifier:'rn_shared_'+'a'.repeat(64)};
const content='【原商家名称】\n两个工作日内发货。';
test('encrypted journal preserves exact historical merchant prefix with fresh nonces and no plaintext',()=>{
 const a=sealAutomaticWeChatEnvelope(lease,target,content,secret),b=sealAutomaticWeChatEnvelope(lease,target,content,secret);
 assert.deepEqual(openAutomaticWeChatEnvelope(lease,a,secret),{target,content});
 assert.notDeepEqual(a.nonce,b.nonce);assert.notDeepEqual(a.ciphertext,b.ciphertext);
 assert.equal(a.ciphertext.includes(Buffer.from(content)),false);
 assert.equal(a.ciphertext.includes(Buffer.from(target.contactIdentifier)),false);
});
test('journal is bound to the entire immutable sending lease, not merely a job UUID',()=>{
 const row=sealAutomaticWeChatEnvelope(lease,target,content,secret);
 for(const patch of [{jobId:id('e')},{tenantId:'merchant-B'},{workerToken:id('e')},{channel:'wechat_official_account',connectionId:id('e')},
  {accountId:'9'},{conversationId:'9'},{customerId:id('e')},{messageId:'9'},{authorizationId:id('e')},{consentVersion:'changed'}]){
  assert.throws(()=>openAutomaticWeChatEnvelope({...lease,...patch} as AutomaticReceptionLease,row,secret),/^Error: automatic_wechat_envelope_unavailable$/);
 }
 const independent={...lease,channel:'wechat_official_account' as const,connectionId:id('e')};
 const native={...target,provider:'wechat_official_account' as const,contactIdentifier:id('e')+':isolated-open'};
 const i=sealAutomaticWeChatEnvelope(independent,native,content,secret);
 assert.throws(()=>openAutomaticWeChatEnvelope({...independent,connectionId:id('f')},i,secret),/envelope_unavailable/);
});
test('ciphertext, tag, nonce, version, size and key tampering fail with a fixed redacted error',()=>{
 const row=sealAutomaticWeChatEnvelope(lease,target,content,secret);
 for(const field of ['ciphertext','nonce','auth_tag'] as const){
  const value=Buffer.from(row[field]);value[0]^=1;
  assert.throws(()=>openAutomaticWeChatEnvelope(lease,{...row,[field]:value},secret),/^Error: automatic_wechat_envelope_unavailable$/);
 }
 for(const patch of [{envelope_version:2},{nonce:Buffer.alloc(11)},{auth_tag:Buffer.alloc(15)},{ciphertext:Buffer.alloc(16385)},{ciphertext:Buffer.alloc(0)}])
  assert.throws(()=>openAutomaticWeChatEnvelope(lease,{...row,...patch},secret),/envelope_unavailable/);
 assert.throws(()=>openAutomaticWeChatEnvelope(lease,row,secret+'rotated'),/envelope_unavailable/);
});
test('invalid content and cross-tenant native target never reach SQL',async()=>{
 const db={query:async()=>{assert.fail('invalid input must not reach SQL');}} as any;
 for(const body of [' ', '字'.repeat(601),'bad\0body','bad\ud800'])
  await assert.rejects(persistAutomaticWeChatEnvelope(db,lease,target,body,secret),/^Error: automatic_wechat_envelope_invalid$/);
 await assert.rejects(persistAutomaticWeChatEnvelope(db,lease,{...target,accountId:'9'},content,secret),/envelope_invalid/);
});
test('only an identical lease and historical body can reuse a durable encrypted journal',async()=>{
 const row=sealAutomaticWeChatEnvelope(lease,target,content,secret);let calls=0;
 const db={query:async(sql:string,values:any[])=>{calls++;
  if(sql.startsWith('INSERT')){assert.ok(Buffer.isBuffer(values[5]));return {rowCount:0,rows:[]};}
  assert.match(sql,/j\.authorization_id=\$10 AND j\.consent_version=\$11/);
  assert.deepEqual(values,[lease.jobId,lease.tenantId,lease.workerToken,lease.channel,lease.accountId,lease.conversationId,
   lease.messageId,lease.customerId,lease.connectionId,lease.authorizationId,lease.consentVersion]);
  return {rowCount:1,rows:[row]};}} as any;
 await persistAutomaticWeChatEnvelope(db,lease,target,content,secret);assert.equal(calls,2);
 await assert.rejects(persistAutomaticWeChatEnvelope(db,lease,target,'【新商家名称】\n两个工作日内发货。',secret),/binding_conflict/);
 await assert.rejects(persistAutomaticWeChatEnvelope(db,lease,target,content,secret+'rotated'),/^Error: automatic_wechat_envelope_binding_conflict$/);
});
