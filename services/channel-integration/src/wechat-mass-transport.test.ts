import test from 'node:test';
import assert from 'node:assert/strict';
import {submitOfficialMassText,queryOfficialMassStatus} from './wechat-official.js';
test('real mass adapter uses the batch endpoint and verifies query receipts without network access',async(t)=>{
  const keys=['MESSAGE_CAMPAIGN_EXECUTION_ENABLED','MESSAGE_CAMPAIGN_PROVIDER','SHARED_WECHAT_APP_ID'] as const;
  const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));const originalFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=originalFetch;for(const k of keys){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}});
  process.env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED='true';process.env.MESSAGE_CAMPAIGN_PROVIDER='wechat_mass';process.env.SHARED_WECHAT_APP_ID='wxshared0000000000';
  const calls:string[]=[];
  globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input));calls.push(url.pathname);
    if(url.pathname==='/cgi-bin/stable_token')return Response.json({access_token:'synthetic-test-token',expires_in:7200});
    const body=JSON.parse(String(init?.body));
    if(url.pathname==='/cgi-bin/message/mass/send') {
      assert.deepEqual(body.touser,['synthetic-one','synthetic-two']);assert.equal(body.clientmsgid,'a'.repeat(32));
      return Response.json({errcode:0,msg_id:123});
    }
    assert.equal(url.pathname,'/cgi-bin/message/mass/get');assert.equal(body.msg_id,'123');
    return Response.json({msg_id:123,msg_status:'SENDING'});
  };
  const config={appId:'wxsynthetic0000001',appSecret:'not-a-real-secret',token:'test-only'};
  assert.equal(await submitOfficialMassText(config,['synthetic-one','synthetic-two'],'test','a'.repeat(32)),'123');
  assert.equal(await queryOfficialMassStatus(config,'123'),'sending');
  assert.ok(!calls.includes('/cgi-bin/message/custom/send'));
  const before=calls.length;
  await assert.rejects(()=>submitOfficialMassText({...config,appId:process.env.SHARED_WECHAT_APP_ID!},['one','two'],'test','a'.repeat(32)),/independent_channel/);
  process.env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED='false';
  await assert.rejects(()=>submitOfficialMassText(config,['one','two'],'test','a'.repeat(32)),/execution_disabled/);
  assert.equal(calls.length,before);
});
