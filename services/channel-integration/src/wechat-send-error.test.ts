import test from "node:test";
import assert from "node:assert/strict";
import { WeChatSendRejected,wechatRejectionState } from "./wechat-send-error.js";
import { sendOfficialText } from "./wechat-official.js";
test("provider rejection taxonomy excludes arbitrary network errors",()=>{
  assert.equal(wechatRejectionState(45015),"shared_window_expired");
  for(const code of [45009,45011,45047]) assert.equal(wechatRejectionState(code),"shared_rate_limited");
  assert.equal(wechatRejectionState(48001),"shared_permission_denied");
  assert.equal(wechatRejectionState(99999),"shared_rejected");
  assert.equal(new Error("timeout") instanceof WeChatSendRejected,false);
});
test("explicit WeChat errors are typed; HTTP and malformed replies remain uncertain",async()=>{
  const before=globalThis.fetch,flag=process.env.WECHAT_LIVE_ENABLED;
  const config={appId:"wx-send-rejection-test",appSecret:"test-only",token:"test-only"};
  try {
    process.env.WECHAT_LIVE_ENABLED="true";
    for(const code of [45009,45015,48001,99999]) {
      globalThis.fetch=async url=>new Response(JSON.stringify(String(url).endsWith('stable_token')?{access_token:'test-only',expires_in:7200}:{errcode:code,errmsg:'private-provider-details'}));
      await assert.rejects(sendOfficialText('test-user','test',config),(e:unknown)=>e instanceof WeChatSendRejected && e.providerCode===code && !e.message.includes('private-provider'));
    }
    globalThis.fetch=async()=>new Response(JSON.stringify({errcode:45009}),{status:502});
    await assert.rejects(sendOfficialText('test-user','test',config),(e:unknown)=>e instanceof Error && !(e instanceof WeChatSendRejected));
  } finally {globalThis.fetch=before;if(flag===undefined)delete process.env.WECHAT_LIVE_ENABLED;else process.env.WECHAT_LIVE_ENABLED=flag;}
});
