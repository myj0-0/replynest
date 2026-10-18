import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { handleSharedWechatCallback, encryptSharedReply, sharedControlText, type SharedCallbackDependencies } from "./shared-wechat-callback.js";
import { decryptOfficialPayload, verifyOfficialMessageSignature } from "./wechat-official.js";
import type { VerifiedSharedEvent } from "./shared-wechat-store.js";

const now = 1789800000000, timestamp = String(now / 1000);
const key = randomBytes(32);
const config = { appId: "wx-shared-test", appSecret: "", token: "test-token", receiverId: "gh_shared", encodingAesKey: key.toString("base64").slice(0,-1) };
function envelope(xml: string, appId = config.appId) {
  const data = Buffer.from(xml), header = Buffer.alloc(20); header.writeUInt32BE(data.length,16);
  const plain = Buffer.concat([header,data,Buffer.from(appId)]), pad = 32 - plain.length % 32;
  const cipher = createCipheriv("aes-256-cbc",key,key.subarray(0,16)); cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([plain,Buffer.alloc(pad,pad)])),cipher.final()]).toString("base64");
  const query = new URLSearchParams({timestamp,nonce:"test",msg_signature:createHash("sha1").update([config.token,timestamp,"test",encrypted].sort().join("")).digest("hex")});
  return { body:`<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,query,encrypted };
}
const message = (extra = "<MsgType>text</MsgType><Content>hello</Content><MsgId>123</MsgId>", receiver = config.receiverId) => `<xml><ToUserName>${receiver}</ToUserName><FromUserName>openid-user</FromUserName><CreateTime>${timestamp}</CreateTime>${extra}</xml>`;

test("independent encrypted callback: gates, identity validation, durable ACK and sanitized errors", async () => {
  const received: VerifiedSharedEvent[] = [];
  let fail = false;
  const deps: SharedCallbackDependencies = {enabled:true,config,now:()=>now,record:async input=>{
    if(fail) throw new Error("secret internal failure"); received.push(input);
    return {duplicate:false,decision:{action:"route",tenantId:"a",state:{appId:config.appId,openId:input.openId,associations:[],version:1,lastTransitionAt:0}}};
  }};
  const server = createServer(async (req,res)=>{ await handleSharedWechatCallback(req,res,new URL(req.url!,"http://local"),deps); });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const addr=server.address(); assert(addr && typeof addr!=="string");
  const base=`http://127.0.0.1:${addr.port}/webhooks/shared-wechat`;
  const post=(fixture=envelope(message()))=>fetch(`${base}?${fixture.query}`,{method:"POST",body:fixture.body});
  try {
    deps.enabled=false; assert.equal((await post()).status,404); assert.equal(received.length,0); deps.enabled=true;
    const ok=await post(); assert.equal(ok.status,200); assert.equal(await ok.text(),"success");
    assert.equal(received[0].appId,config.appId); assert.equal(received[0].text,"hello"); assert.equal(received[0].kind,"text");
    assert.equal((await post(envelope(message(),"foreign-app"))).status,403);
    assert.equal((await post(envelope(message(undefined,"gh_wrong")))).status,403);
    const bad=envelope(message()); bad.query.set("msg_signature","0".repeat(40)); assert.equal((await post(bad)).status,403);
    const stale=envelope(message()); stale.query.set("timestamp","1710000000"); assert.equal((await post(stale)).status,403);
    assert.equal((await fetch(`${base}?timestamp=${timestamp}&signature=abc`,{method:"POST",body:message()})).status,403);
    assert.equal(received.length,1);
    const scan=envelope(message("<MsgType>event</MsgType><Event>SCAN</Event><EventKey>rn_test</EventKey>"));
    assert.equal((await post(scan)).status,200); assert.equal(received[1].kind,"scan"); assert.equal(received[1].eventKey,"rn_test");
    const unsupported=envelope(message("<MsgType>location</MsgType>"));
    assert.equal((await post(unsupported)).status,200); assert.equal(received.length,2);
    assert.equal((await post(envelope(message().replace(`<CreateTime>${timestamp}</CreateTime>`,"<CreateTime>1710000000</CreateTime>")))).status,400);
    assert.equal((await post(envelope(message("<MsgType>text</MsgType><Content>missing id</Content>")))).status,400);
    const unsubscribe=envelope(message("<MsgType>event</MsgType><Event>unsubscribe</Event>"));
    assert.equal((await post(unsubscribe)).status,200); assert.equal(received[2].kind,"unsubscribe");
    assert.equal((await fetch(base,{method:"DELETE"})).status,405);
    const cleared:string[]=[];deps.clearProfile=async id=>{cleared.push(id);};
    const revoke=envelope(message(`<MsgType>event</MsgType><Event>user_authorization_revoke</Event><AppID>${config.appId}</AppID><OpenID>profile-user</OpenID><RevokeInfo>205</RevokeInfo>`));
    assert.equal((await post(revoke)).status,200);assert.deepEqual(cleared,['profile-user']);
    const wrongRevoke=envelope(message('<MsgType>event</MsgType><Event>user_authorization_revoke</Event><AppID>other-app</AppID><OpenID>profile-user</OpenID>'));
    assert.equal((await post(wrongRevoke)).status,403);assert.equal(cleared.length,1);
    fail=true; const failed=await post(); assert.equal(failed.status,503); assert.equal(await failed.text(),"temporarily unavailable");
    const echo=envelope("echo-ok"); echo.query.set("echostr",echo.encrypted);
    const verify=await fetch(`${base}?${echo.query}`); assert.equal(verify.status,200); assert.equal(await verify.text(),"echo-ok");
    const countBefore=received.length; deps.handshakeOnly=true;
    const plainEcho=new URLSearchParams({timestamp,nonce:'plain-verify',echostr:'plain-echo',signature:createHash('sha1').update([config.token,timestamp,'plain-verify'].sort().join('')).digest('hex')});
    const plainVerify=await fetch(`${base}?${plainEcho}`);assert.equal(plainVerify.status,200);assert.equal(await plainVerify.text(),'plain-echo');
    assert.equal((await fetch(`${base}?${plainEcho}`,{method:'POST',body:message()})).status,403);
    plainEcho.set('signature','0'.repeat(40));assert.equal((await fetch(`${base}?${plainEcho}`)).status,403);
    assert.equal((await fetch(`${base}?${echo.query}`)).status,200);
    assert.equal((await post()).status,503);assert.equal(received.length,countBefore);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});

test("control replies are encrypted and selection text contains no internal tenant IDs",()=>{
  const decision = {action:"choose" as const,state:{appId:config.appId,openId:"user",version:1,lastTransitionAt:0,
    associations:[{tenantId:"private-tenant-id",name:"商家A"}],choices:{expiresAt:now+600000,items:[{tenantId:"private-tenant-id",code:"opaque-code"}]}}};
  const text=sharedControlText(decision)!; assert(text.includes("选择 opaque-code")); assert(!text.includes("private-tenant-id"));
  const xml=encryptSharedReply(text+" ]]>","user",config,now);
  const encrypted=xml.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/)![1];
  const nonce=xml.match(/<Nonce><!\[CDATA\[(.*?)\]\]><\/Nonce>/)![1];
  const signature=xml.match(/<MsgSignature><!\[CDATA\[(.*?)\]\]><\/MsgSignature>/)![1];
  assert(verifyOfficialMessageSignature(config.token,timestamp,nonce,encrypted,signature));
  const decoded=decryptOfficialPayload(encrypted,config.encodingAesKey,config.appId);
  assert(decoded.includes("商家A")); assert(decoded.includes("]]]]><![CDATA[>"));
});

test('encrypted media callbacks persist verified descriptors and prompt merchant selection',async()=>{
  const received:VerifiedSharedEvent[]=[];
  const deps:SharedCallbackDependencies={enabled:true,config,now:()=>now,record:async input=>{
    received.push(input);return {duplicate:false,decision:{action:'choose',state:{appId:config.appId,openId:input.openId,version:1,lastTransitionAt:0,associations:[{tenantId:'a',name:'商家A'},{tenantId:'b',name:'商家B'}],choices:{expiresAt:now+600000,items:[{tenantId:'a',code:'opaque-a'},{tenantId:'b',code:'opaque-b'}]}}}};
  }};
  const server=createServer(async(req,res)=>{await handleSharedWechatCallback(req,res,new URL(req.url!,'http://local'),deps);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const addr=server.address();assert(addr&&typeof addr!=='string');
  try{
    for(const type of ['image','video','voice','shortvideo']){
      const fixture=envelope(message(`<MsgType>${type}</MsgType><MediaId>synthetic-media</MediaId><MsgId>456</MsgId><Format>amr</Format><Recognition>选择 opaque-b</Recognition><PicUrl>http://127.0.0.1/private</PicUrl>`));
      const res:Response=await fetch(`http://127.0.0.1:${addr.port}/webhooks/shared-wechat?${fixture.query}`,{method:'POST',body:fixture.body});
      assert.equal(res.status,200);const body=await res.text();const encrypted=body.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/)![1];
      const plain=decryptOfficialPayload(encrypted,config.encodingAesKey,config.appId);
      assert.match(plain,/选择商家后，请重新发送/);assert.equal(received.at(-1)?.kind,'media');
      assert.equal(received.at(-1)?.media?.kind,type==='shortvideo'?'video':type);assert.doesNotMatch(JSON.stringify(received.at(-1)?.media),/127\.0\.0\.1/);
    }
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
