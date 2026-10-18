import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { validateOpenScopes,projectOpenCustomer,validateAppData,webhookSignature,publicWebhookIpv4 } from './open-platform-core.js';
import { parseWorkbenchSearch,likeLiteral } from './workbench-search.js';
import { encodeConversationCursor,decodeConversationCursor } from './conversation-headless-core.js';
test('only explicit customer fields leave the platform',()=>{
  const row={customer_id:'x',name:'Alice',phone:'123',email:'mail',support_note:'private',attributes:{secret:1},tenant_id:'a'};
  assert.deepEqual(projectOpenCustomer(row,['customers.contact.read']),{id:'x',phone:'123',email:'mail'});
  assert.deepEqual(projectOpenCustomer(row,[]),{id:'x'});
  assert.throws(()=>validateOpenScopes(['admin']));assert.throws(()=>validateOpenScopes(['customers.notes.read','customers.notes.read']));
});
test('app records cannot introduce tenant controls, nested code or unbounded data',()=>{
  assert.deepEqual(validateAppData({subject:'test',amount:100,done:false}),{subject:'test',amount:100,done:false});
  for(const value of [{tenant_id:'b'},{constructor:'x'},{nested:{a:1}},{text:'a'.repeat(2001)}])assert.throws(()=>validateAppData(value));
});
test('signature binds timestamp and exact raw payload; private targets rejected',()=>{
  const body='{"id":"a"}';assert.equal(webhookSignature('secret','100',body),'v1='+createHmac('sha256','secret').update('100.'+body).digest('hex'));
  for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','::1','::ffff:7f00:1','224.1.1.1','198.18.0.1'])assert.equal(publicWebhookIpv4(ip),false,ip);
  assert.equal(publicWebhookIpv4('8.8.8.8'),true);
});
test('search boundaries, literal SQL wildcard and filter-bound cursors',()=>{
  const a=parseWorkbenchSearch(new URLSearchParams({profile:'test',from:'2026-09-25',to:'2026-09-25'}));
  assert.equal(a.until!-a.since!,86400000);assert.equal(new Date(a.since!).toISOString(),'2026-09-24T16:00:00.000Z');
  for(const params of [{from:'2026-02-30'},{from:'2026-09-26',to:'2026-09-25'},{profile:'a'.repeat(121)}] as Record<string,string>[])assert.throws(()=>parseWorkbenchSearch(new URLSearchParams(params)));
  assert.equal(likeLiteral('a%_\\'),'%a\\%\\_\\\\%');
  const secret='a'.repeat(32),cursor=encodeConversationCursor(secret,'a',a.scope,'6');
  assert.equal(decodeConversationCursor(cursor,secret,'a',a.scope),'6');
  assert.equal(decodeConversationCursor(cursor,secret,'b',a.scope),undefined);
  assert.equal(decodeConversationCursor(cursor,secret,'a',parseWorkbenchSearch(new URLSearchParams({profile:'other'})).scope),undefined);
});
