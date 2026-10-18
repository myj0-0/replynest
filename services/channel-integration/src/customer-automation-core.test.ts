import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCustomerAutomationControl} from './customer-automation-core.js';
import {createAutomaticNativeClient} from './automatic-web-native-client.js';
const customer='aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',actor='bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const nativeScope={conversation_id:'2',contact_id:'3',native_actor_id:'4',permission_scope:'assigned' as const};
test('only timed pauses and explicit early resume; strict fields and revision',()=>{
 assert.deepEqual(validateCustomerAutomationControl({operation:'pause',minutes:10,revision:'0'}),{operation:'pause',minutes:10,revision:'0'});
 assert.ok(validateCustomerAutomationControl({operation:'resume',minutes:0,revision:'5'}));
 for(const patch of [{minutes:0},{minutes:30},{minutes:60},{minutes:-1},{minutes:'10'},{revision:1},{revision:'-1'},{revision:'9223372036854775807'},{customer_id:customer},{operation:'permanent'}])assert.equal(validateCustomerAutomationControl({operation:'pause',minutes:10,revision:'0',...patch}),null);
});
test('customer control sends one signed request, binds account/customer; no retry after conflict or missing acknowledgement',async()=>{
 let calls=0;const opts={origin:'http://isolated.invalid',secret:'isolated-customer-control-0000000000000000'};
 const c=createAutomaticNativeClient({...opts,fetcher:async(url,init)=>{
  calls++;assert.equal(String(url),'http://isolated.invalid/internal/saas_sso/customer_automation/control');assert.equal(new Headers(init?.headers).get('api_access_token'),null);
  assert.deepEqual(JSON.parse(String(init?.body)),{account_id:'1',customer_id:customer,operation:'pause',minutes:10,revision:'0',actor_id:actor,request_id:'test',...nativeScope});
  return Response.json({account_id:'1',customer_id:customer,paused:true,paused_until:'2026-10-05T10:10:00.000000Z',revision:'1'});
 }});
 assert.equal((await c.customerControl('1',customer,{operation:'pause',minutes:10,revision:'0',actor_id:actor,request_id:'test',...nativeScope})).paused,true);assert.equal(calls,1);
 for(const [status,body] of [[409,{error:'pause_conflict'}],[403,{error:'pause_forbidden'}],[200,{account_id:'2',customer_id:customer}]] as const){
  calls=0;const port=createAutomaticNativeClient({...opts,fetcher:async()=>{calls++;return Response.json(body,{status});}});
  await assert.rejects(()=>port.customerControl('1',customer),status===403?/customer_automation_forbidden/:/customer_automation_/);assert.equal(calls,1);
 }
});
test('native customer writes require an explicit signed seat/conversation/contact scope before network access',async()=>{
 let calls=0;const c=createAutomaticNativeClient({origin:'http://isolated.invalid',secret:'isolated-customer-control-0000000000000000',fetcher:async()=>{calls++;throw Error('must_not_call');}});
 const input={operation:'pause' as const,minutes:10 as const,revision:'0',actor_id:actor,request_id:'test',...nativeScope};
 for(const patch of [{conversation_id:'0'},{contact_id:'2;DROP'},{native_actor_id:'9223372036854775808'},{permission_scope:'all'},{native_actor_id:undefined}])
  await assert.rejects(()=>c.customerControl('1',customer,{...input,...patch} as typeof input),/invalid_customer_automation/);
 assert.equal(calls,0);
});
