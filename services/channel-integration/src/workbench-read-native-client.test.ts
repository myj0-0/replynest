import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {createWorkbenchReadNativeClient,parseWorkbenchRead,validateWorkbenchRead,type WorkbenchReadRequest} from './workbench-read-native-client.js';
const request:WorkbenchReadRequest={account_id:'1',native_actor_id:'2',operation:'mark',conversation_ids:['3'],message_ids:['101','103']};
const response=(body:string)=>({account_id:'1',operation:'mark',request_sha256:createHash('sha256').update(body).digest('hex'),counts:[{conversation_id:'3',unread_count:2,capped:false}]});
test('read request requires exact distinct displayed messages and bounded distinct conversations',()=>{
 validateWorkbenchRead(request);validateWorkbenchRead({account_id:'1',native_actor_id:'2',operation:'stats',conversation_ids:['3','4']});
 for(const patch of [{message_ids:undefined},{message_ids:[]},{message_ids:['101','101']},{message_ids:['0']},{message_ids:['9223372036854775808']},{conversation_ids:['3','4']},{account_id:'0'},{native_actor_id:'9223372036854775808'},{operation:'send'},{conversation_ids:['3','3']}])assert.throws(()=>validateWorkbenchRead({...request,...patch} as WorkbenchReadRequest));
 assert.throws(()=>validateWorkbenchRead({...request,conversation_ids:Array.from({length:101},(_,i)=>String(i+1))}));
 assert.throws(()=>validateWorkbenchRead({...request,tenant_id:'other'} as WorkbenchReadRequest));
 assert.throws(()=>validateWorkbenchRead({...request,message_ids:Array.from({length:101},(_,i)=>String(i+1))}));
 assert.throws(()=>validateWorkbenchRead({...request,message_id:'104'} as WorkbenchReadRequest));
});
test('exact read response retains unacknowledged messages and rejects scope drift',()=>{
 const body=JSON.stringify(request),valid=response(body);
 assert.equal(parseWorkbenchRead(valid,request,body)[0].unread_count,2);
 for(const patch of [{account_id:'9'},{operation:'stats'},{request_sha256:'a'.repeat(64)},{counts:[]},{counts:[{conversation_id:'99',unread_count:0,capped:false}]},
  {counts:[{conversation_id:'3',unread_count:1001,capped:true}]},{counts:[{conversation_id:'3',unread_count:999,capped:true}]}])assert.throws(()=>parseWorkbenchRead({...valid,...patch},request,body));
 for(const capped of [false,true])assert.deepEqual(parseWorkbenchRead({...valid,counts:[{conversation_id:'3',unread_count:1000,capped}]},request,body)[0],{conversation_id:'3',unread_count:1000,capped});
});
test('fixed internal HMAC route, no administrator API credential, no retry',async()=>{
 const secret='synthetic-read-secret-not-a-real-key';let calls=0;
 const fetcher:typeof fetch=async(url,options)=>{
  calls++;assert.equal(String(url),'http://native.invalid/internal/saas_sso/workbench_read/control');assert.equal(options?.redirect,'error');
  const headers=new Headers(options?.headers),body=String(options?.body);
  assert.equal(headers.get('api_access_token'),null);
  assert.equal(headers.get('x-automatic-signature'),createHmac('sha256',secret).update(`/internal/saas_sso/workbench_read/control\n${headers.get('x-automatic-timestamp')}\n${headers.get('x-automatic-nonce')}\n${body}`).digest('hex'));
  return Response.json(response(body));
 };
 assert.equal((await createWorkbenchReadNativeClient({origin:'http://native.invalid',secret,fetcher}).control(request))[0].unread_count,2);assert.equal(calls,1);
 const unavailable=createWorkbenchReadNativeClient({origin:'http://native.invalid',secret,fetcher:async()=>{calls++;throw Error('timeout');}});
 await assert.rejects(unavailable.control(request));assert.equal(calls,2);
});
test('oversized and duplicate JSON responses cannot clear a badge',async()=>{
 const secret='synthetic-read-secret-not-a-real-key';
 for(const malformed of ['{"account_id":"1","account_id":"9"}', ' '.repeat(32769)]){
  const client=createWorkbenchReadNativeClient({origin:'http://native.invalid',secret,fetcher:async()=>new Response(malformed)});
  await assert.rejects(client.control(request));
 }
});
