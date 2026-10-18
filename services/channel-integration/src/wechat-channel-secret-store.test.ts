import assert from "node:assert/strict";
import test from "node:test";
import { decryptWeChatCredential, encryptWeChatCredential } from "./wechat-channel-secret-store.js";

test("tenant WeChat credentials are authenticated and never stored as plaintext",()=>{
  const previous=process.env.WECHAT_CHANNEL_MASTER_KEY;process.env.WECHAT_CHANNEL_MASTER_KEY=Buffer.alloc(32,9).toString("base64");
  try{
    const value={app_id:"wx1234567890abcdef",app_secret:"a".repeat(32),token:"b".repeat(32),encoding_aes_key:"c".repeat(43)};
    const encrypted=encryptWeChatCredential(value);const serialized=JSON.stringify(encrypted);
    assert.equal(serialized.includes(value.app_secret),false);assert.deepEqual(decryptWeChatCredential(encrypted),value);
    assert.throws(()=>decryptWeChatCredential({...encrypted,ciphertext:`${encrypted.ciphertext}x`}),/authenticate|invalid/i);
  }finally{if(previous===undefined)delete process.env.WECHAT_CHANNEL_MASTER_KEY;else process.env.WECHAT_CHANNEL_MASTER_KEY=previous;}
});
