import test from "node:test";
import assert from "node:assert/strict";
import { createSharedWechatTransport } from "./shared-wechat-transport.js";

test("account-scoped transport verifies inbox/conversation before writing and hides OpenID",async()=>{
  const calls:{url:string;body:any}[]=[];
  let wrongInbox=false,wrongContact=false;
  const fake:typeof fetch=async(input,init)=>{
    const url=String(input),body=init?.body?JSON.parse(String(init.body)):null; calls.push({url,body});
    assert.equal(init?.redirect,"error");
    let data:any;
    if(url.endsWith("/inboxes/2"))data={id:2,channel_type:"Channel::Api"};
    else if(url.endsWith("/contacts"))data={payload:{contact:{id:3,identifier:"hashed-key",contact_inboxes:[{inbox:{id:2},source_id:"opaque-source"}]}}};
    else if(url.endsWith("/conversations"))data={id:4};
    else if(url.endsWith("/conversations/4"))data={id:4,account_id:1,inbox_id:wrongInbox?99:2,meta:{sender:{id:3}},custom_attributes:{replynest_shared_contact:wrongContact?"other":"hashed-key"}};
    else if(url.endsWith("/messages"))data={id:5,conversation_id:4};
    else throw new Error("unexpected path");
    return new Response(JSON.stringify(data),{status:200});
  };
  const transport=createSharedWechatTransport({chatwootBaseUrl:"http://test",chatwootToken:"test",fetcher:fake,liveSendEnabled:false,resolveWeChat:async()=>{throw new Error("must not resolve while disabled");}});
  const target={appId:"app",tenantId:"tenant",accountId:"1",inboxId:"2",openId:"sensitive-openid"},message={content:"hi",eventId:"event",contactKey:"hashed-key"};
  assert.deepEqual(await transport.receive(target,message),{accountId:"1",inboxId:"2",conversationId:"4",contactId:"3",messageId:"5"});
  assert(calls.every(c=>c.url.startsWith("http://test/api/v1/accounts/1/"))); assert(!JSON.stringify(calls).includes(target.openId));
  assert.equal(calls.at(-1)!.body.message_type,"incoming");
  const bound={accountId:"1",inboxId:"2",conversationId:"4"};
  wrongInbox=true; calls.length=0;
  await assert.rejects(transport.receive(target,message,bound),/shared_conversation_mismatch/); assert(calls.every(c=>!c.body));
  wrongInbox=false;wrongContact=true;calls.length=0;
  await assert.rejects(transport.receive(target,message,bound),/shared_conversation_mismatch/);assert(calls.every(c=>!c.body));
  await assert.rejects(transport.send(target,{content:"reply",commandId:"manual"}),/shared_send_disabled/);
});

test("WeChat sender rejects credential account mismatch before any send",async()=>{
  let sent=0;
  const transport=createSharedWechatTransport({chatwootBaseUrl:"http://test",chatwootToken:"test",liveSendEnabled:true,
    resolveWeChat:async()=>({appId:"other",appSecret:"test",token:"test"}),sender:async()=>{sent++;}});
  await assert.rejects(transport.send({appId:"app",tenantId:"a",accountId:"1",inboxId:"2",openId:"user"},{content:"reply",commandId:"one"}),/shared_sender_account_mismatch/);
  assert.equal(sent,0);
});
