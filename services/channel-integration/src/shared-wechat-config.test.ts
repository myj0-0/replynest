import test from "node:test";
import assert from "node:assert/strict";
import { sharedWechatConfig } from "./shared-wechat-config.js";

test("shared configuration validates account identity and never falls back from a broken credential reference",async()=>{
  const keys=["SHARED_WECHAT_APP_ID","SHARED_WECHAT_RECEIVER_ID","SHARED_WECHAT_CREDENTIAL_REF","SHARED_WECHAT_APP_SECRET","SHARED_WECHAT_CALLBACK_TOKEN","SHARED_WECHAT_ENCODING_AES_KEY"];
  const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try {
    for(const k of keys)delete process.env[k];
    await assert.rejects(sharedWechatConfig,/shared_account_config_invalid/);
    process.env.SHARED_WECHAT_APP_ID='wx1234567890123456';process.env.SHARED_WECHAT_RECEIVER_ID='gh_pilot';
    process.env.SHARED_WECHAT_CALLBACK_TOKEN='testtoken';process.env.SHARED_WECHAT_ENCODING_AES_KEY='a'.repeat(43);
    assert.equal((await sharedWechatConfig()).receiverId,'gh_pilot');
    process.env.SHARED_WECHAT_CREDENTIAL_REF='/outside/credential.json';
    await assert.rejects(sharedWechatConfig,/wechat_credential_ref_outside_root/);
  }finally{for(const k of keys)if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}
});
