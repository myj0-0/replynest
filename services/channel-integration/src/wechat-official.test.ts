import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { decryptOfficialPayload, officialConfigFromEnv, parseOfficialInbound, verifyOfficialCallback, verifyOfficialSignature } from "./wechat-official.js";

function encryptedFixture(appId: string, xmlText: string) {
  const key = randomBytes(32);
  const encodingKey = key.toString("base64").replace(/=$/, "");
  const xml = Buffer.from(xmlText);
  const header = Buffer.alloc(20);
  randomBytes(16).copy(header, 0);
  header.writeUInt32BE(xml.length, 16);
  let plain = Buffer.concat([header, xml, Buffer.from(appId)]);
  const padding = 32 - (plain.length % 32 || 32);
  const size = padding === 0 ? 32 : padding;
  plain = Buffer.concat([plain, Buffer.alloc(size, size)]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return { encodingKey, encrypted: Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64") };
}

test("official callback signature follows WeChat SHA-1 sorting", () => {
  assert.equal(verifyOfficialSignature("test-token", "1409659813", "1320562132", "67a54e4c7e6248b2b74b0d7a36e86d2e16b8a5c9"), false);
  const expected = createHash("sha1").update(["test-token", "1409659813", "1320562132"].sort().join("")).digest("hex");
  assert.equal(verifyOfficialSignature("test-token", "1409659813", "1320562132", expected), true);
});

test("official configuration uses the shared secret resolver", () => {
  const names = ["WECHAT_OFFICIAL_APP_ID","WECHAT_OFFICIAL_APP_SECRET","WECHAT_OFFICIAL_APP_SECRET_FILE","WECHAT_OFFICIAL_TOKEN","WECHAT_OFFICIAL_TOKEN_FILE"] as const;
  const previous = Object.fromEntries(names.map(name=>[name,process.env[name]]));
  delete process.env.WECHAT_OFFICIAL_APP_SECRET_FILE;
  delete process.env.WECHAT_OFFICIAL_TOKEN_FILE;
  process.env.WECHAT_OFFICIAL_APP_ID = "wx-test";
  process.env.WECHAT_OFFICIAL_APP_SECRET = "0123456789abcdef0123456789abcdef";
  process.env.WECHAT_OFFICIAL_TOKEN = "callback-token";
  const config = officialConfigFromEnv();
  assert.equal(config.appSecret, "0123456789abcdef0123456789abcdef");
  assert.equal(config.token, "callback-token");
  for(const name of names) if(previous[name]===undefined) delete process.env[name]; else process.env[name]=previous[name];
});

test("plain official text message is normalized", () => {
  const token = "callback-token";
  const timestamp = "1710000000";
  const nonce = "nonce";
  const signature = createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
  const query = new URLSearchParams({ timestamp, nonce, signature });
  const raw = Buffer.from(`<xml><ToUserName><![CDATA[gh_test]]></ToUserName><FromUserName><![CDATA[openid-1]]></FromUserName><CreateTime>1710000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好 & 欢迎]]></Content><MsgId>123456</MsgId></xml>`);
  const message = parseOfficialInbound(raw, query, { appId: "wx-test", token });
  assert.equal(message.user_id, "openid-1");
  assert.equal(message.text, "你好 & 欢迎");
  assert.equal(message.message_id, "123456");
});

test("encrypted official payload validates receiver id", () => {
  const appId = "wx-replynest-test";
  const xml = "<xml><Content><![CDATA[test]]></Content></xml>";
  const fixture = encryptedFixture(appId, xml);
  assert.equal(decryptOfficialPayload(fixture.encrypted, fixture.encodingKey, appId), xml);
  assert.throws(() => decryptOfficialPayload(fixture.encrypted, fixture.encodingKey, "wrong-app"), /receiver_mismatch/);
});

test("callback verification accepts a staged candidate without disabling the active credential", () => {
  const timestamp = "1710000000";
  const nonce = "candidate-nonce";
  const echo = "candidate-ok";
  const candidateToken = "candidate-token";
  const signature = createHash("sha1").update([candidateToken, timestamp, nonce].sort().join("")).digest("hex");
  const query = new URLSearchParams({ timestamp, nonce, echostr: echo, signature });
  const config = { appId: "wx-test", token: "active-token", candidateToken };
  assert.equal(verifyOfficialCallback(query, config), echo);
  const activeSignature = createHash("sha1").update([config.token, timestamp, nonce].sort().join("")).digest("hex");
  query.set("signature", activeSignature);
  assert.equal(verifyOfficialCallback(query, config), echo);
});

test("encrypted inbound accepts a staged candidate token and AES key", () => {
  const appId = "wx-replynest-test";
  const candidateToken = "candidate-token";
  const timestamp = "1710000000";
  const nonce = "candidate-nonce";
  const xml = `<xml><ToUserName><![CDATA[gh_test]]></ToUserName><FromUserName><![CDATA[openid-candidate]]></FromUserName><CreateTime>1710000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[candidate]]></Content><MsgId>789012</MsgId></xml>`;
  const fixture = encryptedFixture(appId, xml);
  const signature = createHash("sha1").update([candidateToken, timestamp, nonce, fixture.encrypted].sort().join("")).digest("hex");
  const query = new URLSearchParams({ timestamp, nonce, msg_signature: signature });
  const outer = Buffer.from(`<xml><Encrypt><![CDATA[${fixture.encrypted}]]></Encrypt></xml>`);
  const message = parseOfficialInbound(outer, query, {
    appId,
    token: "active-token",
    encodingAesKey: randomBytes(32).toString("base64").replace(/=$/, ""),
    candidateToken,
    candidateEncodingAesKey: fixture.encodingKey
  });
  assert.equal(message.user_id, "openid-candidate");
  assert.equal(message.text, "candidate");
});
