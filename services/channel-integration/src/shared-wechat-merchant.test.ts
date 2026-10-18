import test from 'node:test';
import assert from 'node:assert/strict';
import {merchantProfile} from './shared-wechat-merchant.js';
import {sendOfficialText,sendSharedOfficialText} from './wechat-official.js';
test('merchant profile only permits bounded plain text and HTTPS website',()=>{
 assert.equal(merchantProfile({introduction:' hello ',website:'https://example.com'}).introduction,'hello');
 for(const website of ['javascript:alert(1)','http://example.com','https://user:pass@example.com'])assert.throws(()=>merchantProfile({introduction:'',website}));
 assert.throws(()=>merchantProfile({introduction:'a'.repeat(301),website:''}));
});
test('shared manual send cannot enable legacy sender or a different account',async()=>{
 const before={...process.env};try {
  process.env.WECHAT_LIVE_ENABLED='false';process.env.SHARED_WECHAT_MANUAL_SEND_ENABLED='true';process.env.SHARED_WECHAT_APP_ID='app';
  await assert.rejects(sendOfficialText('user','hello',{appId:'app',appSecret:'test',token:'test'}),/wechat_live_send_disabled/);
  await assert.rejects(sendSharedOfficialText('user','hello',{appId:'other',appSecret:'test',token:'test'}),/shared_send_disabled/);
 }finally {for(const k of ['WECHAT_LIVE_ENABLED','SHARED_WECHAT_MANUAL_SEND_ENABLED','SHARED_WECHAT_APP_ID'])if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}
});
