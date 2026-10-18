import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {automaticWebSnapshot,loadAutomaticWebTarget,createAutomaticWebChatAdapter,type AutomaticWebTarget} from './automatic-web-chat.js';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
const now=new Date('2026-10-01T03:00:00Z');
const target:AutomaticWebTarget={tenantId:'a',accountId:'1',conversationId:'10',inboxId:'5',contactId:'7',customerId:randomUUID(),connectionId:randomUUID(),authorizationAt:'2026-10-01T02:59:00Z'};
const c={id:10,account_id:1,inbox_id:5,status:'open',can_reply:true,meta:{sender:{id:7},assignee:null},custom_attributes:{}};
const inbox={id:5,account_id:1,channel_type:'Channel::WebWidget'};
const message={id:100,account_id:1,conversation_id:10,private:false,message_type:0,content_type:'text',content:'多久发货？',created_at:now.getTime()/1000,sender:{id:7,type:'contact'}};
const check=(conversation:unknown=c,i:unknown=inbox,messages:unknown={payload:[message]})=>automaticWebSnapshot(target,'100',conversation,i,messages,now);
test('tenant-bound native widget/latest contact text is a candidate, not send authorization',()=>assert.deepEqual(check(),{current:true,human:false,replyable:true,question:'多久发货？'}));
test('foreign account, inbox, contact and API/shared inbox are rejected',()=>{
 for(const changes of [{account_id:2},{inbox_id:6},{meta:{sender:{id:8}}},{custom_attributes:{source_channel:'shared_wechat'}},{custom_attributes:{replynest_shared_contact:'x'}}])assert.equal(check({...c,...changes}).current,false);
 for(const changes of [{account_id:2},{id:6},{channel_type:'Channel::Api'}])assert.equal(check(c,{...inbox,...changes}).replyable,false);
});
test('assignment is routing; obsolete permanent flag does not replace the native timed guard',()=>{
 assert.equal(check({...c,meta:{...c.meta,assignee:{id:9}}}).human,false);
 for(const flag of [true,'false'])assert.equal(check({...c,custom_attributes:{replynest_automation_paused:flag}}).human,false);
 assert.equal(check(c,inbox,{payload:[message,{...message,id:101,message_type:1}]}).human,true);
});
test('newer incoming invalidates the job, private notes do not',()=>{
 assert.equal(check(c,inbox,{payload:[message,{...message,id:101}]}).current,false);
 assert.equal(check(c,inbox,{payload:[message,{...message,id:101,private:true,message_type:1}]}).current,true);
});
test('resolved/closed window and missing replyable flag fail closed',()=>{
 for(const changes of [{status:'resolved'},{status:'snoozed'},{can_reply:false},{can_reply:undefined}])assert.equal(check({...c,...changes}).current,false);
});
test('old, future, pre-grant, non-text and different contact messages fail closed',()=>{
 for(const changes of [{created_at:now.getTime()/1000-601},{created_at:now.getTime()/1000+31},{created_at:'invalid'},{content_type:'image'},{sender:{id:8}},{sender:{id:7,type:'user'}},{sender:{id:7}},{content:''}])assert.equal(check(c,inbox,{payload:[{...message,...changes}]}).current,false);
 assert.equal(automaticWebSnapshot({...target,authorizationAt:now.toISOString()},'100',c,inbox,{payload:[{...message,created_at:now.getTime()/1000-1}]},now).current,false);
});
test('bounded page, duplicate/unsafe IDs and malformed records cannot certify latest state',()=>{
 for(const payload of [[],Array.from({length:21},(_,n)=>({...message,id:n+100})),[message,message],[{...message,id:Number.MAX_SAFE_INTEGER+1}],[{...message,private:undefined}],[{...message,conversation_id:11}]])assert.equal(check(c,inbox,{payload}).current,false);
});
test('non-web channels have no local target or fallback query',async()=>{
 let calls=0;const db={query:async()=>{calls++;throw Error('unexpected');}} as unknown as Pick<PoolClient,'query'>;
 for(const channel of ['shared_wechat','wechat_official_account'] as const)assert.equal(await loadAutomaticWebTarget(db,{channel} as AutomaticReceptionLease),null);
 assert.equal(calls,0);
});
test('ambiguous local bindings do not pick the first customer',async()=>{
 const db={query:async()=>({rows:[{},{}]})} as unknown as Pick<PoolClient,'query'>;
 const l:AutomaticReceptionLease={...target,channel:'web_chat',messageId:'100',authorizationId:randomUUID(),jobId:randomUUID(),workerToken:randomUUID(),consentVersion:'automatic-send-v1'};
 assert.equal(await loadAutomaticWebTarget(db,l),null);
});
test('factory refuses credential-bearing or path-bearing origins without fetching',()=>{
 for(const origin of ['https://user:password@example.test','https://example.test/path','https://example.test/?x=1','file:///tmp/test'])assert.throws(()=>createAutomaticWebChatAdapter({} as never,{origin,secret:'synthetic-native-secret-00000000000000',policy:async()=>({} as never),generate:async()=>({} as never)}),/invalid_automatic_web_config/);
});
