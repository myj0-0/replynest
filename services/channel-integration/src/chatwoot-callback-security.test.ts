import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {authenticateChatwootCallback,canonicalChatwootCallback} from './chatwoot-callback-security.js';

test('callback requires strong dedicated key, timestamp and exact raw-body signature',()=>{
  const key='synthetic-only-'.repeat(3),stamp='1790000000',body=Buffer.from('{"id":1}'),now=Number(stamp)*1000;
  const sig='v1='+createHmac('sha256',key).update(stamp+'.').update(body).digest('hex');
  assert.equal(authenticateChatwootCallback(key,stamp,sig,body,now),true);
  for(const secret of [undefined,'short'])assert.equal(authenticateChatwootCallback(secret,stamp,sig,body,now),false);
  assert.equal(authenticateChatwootCallback(key,stamp,sig,Buffer.from('{}'),now),false);
  assert.equal(authenticateChatwootCallback(key,stamp,sig,body,now+301000),false);
  assert.equal(authenticateChatwootCallback(key,[stamp],sig,body,now),false);
});
test('callback content is replaced by authoritative message; cross-account/private/incoming rejected',()=>{
  const payload={id:4,account:{id:2},conversation:{id:3},content:'forged'},conversation={id:3,account_id:2};
  const message={id:4,conversation_id:3,account_id:2,private:false,message_type:1,content:'verified'};
  assert.equal(canonicalChatwootCallback(payload,'2',conversation,[message]).content,'verified');
  assert.throws(()=>canonicalChatwootCallback(payload,'9',conversation,[message]));
  for(const change of [{private:true},{message_type:0},{account_id:9},{conversation_id:9},{id:5}])
    assert.throws(()=>canonicalChatwootCallback(payload,'2',conversation,[{...message,...change}]));
});
