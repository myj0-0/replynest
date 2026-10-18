import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAutomaticReceptionStartup} from './automatic-reception-config.js';
const bridge='isolated-bridge-key-00000000000000',native='isolated-native-key-00000000000000';
const env:NodeJS.ProcessEnv={AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED:'true',AI_RECEPTION_AUTOMATIC_WEB_ENABLED:'true',
 AI_RECEPTION_EVENT_CALLBACK_ENABLED:'true',AI_POINTS_ENABLED:'true',CHATWOOT_BASE_URL:'http://isolated-native:3000'};
const secret=(name:string)=>({CHATWOOT_CALLBACK_SECRET:bridge,REPLYNEST_AUTOMATIC_REPLY_SECRET:native,CHATWOOT_API_ACCESS_TOKEN:'isolated-read-token'} as Record<string,string>)[name];
test('default-off and management-only never resolve credentials or model configuration',()=>{
 for(const e of [{},{AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED:'true'}]){
  const c=validateAutomaticReceptionStartup(e,()=>{throw Error('secret must not be read');},()=>{throw Error('model must not be read');});
  assert.equal(c.web,false);assert.equal(c.callback,false);assert.equal(c.bridgeSecret,'');assert.ok(Object.isFrozen(c));
 }
});
test('invalid boolean fails closed including callback flag when draft is disabled',()=>{
 for(const name of ['AI_RECEPTION_CLOSED_CALLBACK_ACK_ENABLED','AI_RECEPTION_SENDER_MANAGEMENT_ENABLED','AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED','AI_RECEPTION_AUTOMATIC_WEB_ENABLED','AI_RECEPTION_EVENT_CALLBACK_ENABLED','AI_RECEPTION_DRAFT_WORKER_ENABLED',
  'AI_RECEPTION_AUTOMATIC_WECHAT_MANAGEMENT_ENABLED','AI_RECEPTION_AUTOMATIC_WECHAT_ENABLED','AI_RECEPTION_WECHAT_HISTORY_ENABLED','AI_POINTS_ENABLED','WECHAT_VERIFIED_INGRESS_ENABLED','AI_RECEPTION_REPLY_TIMING_ENABLED']){
  assert.throws(()=>validateAutomaticReceptionStartup({[name]:'TRUE'},secret,()=>{}),/^Error: automatic_reception_flag_invalid$/);
 }
});

test('closed acknowledgement resolves only bridge authentication, not model/native/token/execution',()=>{
 const names:string[]=[];
 const c=validateAutomaticReceptionStartup({AI_RECEPTION_CLOSED_CALLBACK_ACK_ENABLED:'true'},name=>{names.push(name);return secret(name);},()=>assert.fail('no model initialization'));
 assert.deepEqual(names,['CHATWOOT_CALLBACK_SECRET']);
 assert.equal(c.closedCallbackAck,true);assert.equal(c.callback,false);assert.equal(c.web,false);assert.equal(c.wechat,false);
 assert.equal(c.draftCallback,false);assert.equal(c.nativeSecret,'');assert.equal(c.token,'');assert.equal(c.origin,'');
 for(const key of ['', 'short',bridge+'\n'])assert.throws(()=>validateAutomaticReceptionStartup(
  {AI_RECEPTION_CLOSED_CALLBACK_ACK_ENABLED:'true'},()=>key,()=>{}),/configuration_invalid/);
});

test('identity-only startup requires management/verified schema and only the signed-native credential',()=>{
 const e={AI_RECEPTION_SENDER_MANAGEMENT_ENABLED:'true',AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED:'true',
  DATABASE_STARTUP_MODE:'verify',CHATWOOT_BASE_URL:'http://isolated-native:3000'};
 const names:string[]=[];
 const c=validateAutomaticReceptionStartup(e,name=>{names.push(name);return secret(name);},()=>assert.fail('no model initialization'));
 assert.equal(c.senderManagement,true);assert.equal(c.web,false);assert.equal(c.wechat,false);
 assert.equal(c.wechatHistory,false);assert.equal(c.callback,false);assert.equal(c.token,'');assert.equal(c.bridgeSecret,'');
 assert.deepEqual(names,['REPLYNEST_AUTOMATIC_REPLY_SECRET']);
 for(const changed of [{AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED:'false'},{DATABASE_STARTUP_MODE:'legacy'},{DATABASE_STARTUP_MODE:undefined}])
  assert.throws(()=>validateAutomaticReceptionStartup({...e,...changed},secret,()=>{}),/dependencies_required/);
 for(const changed of [{CHATWOOT_BASE_URL:'http://user:password@native'},{CHATWOOT_BASE_URL:'http://native/private'}])
  assert.throws(()=>validateAutomaticReceptionStartup({...e,...changed},secret,()=>{}),/configuration_invalid/);
 assert.throws(()=>validateAutomaticReceptionStartup(e,()=> 'short',()=>{}),/configuration_invalid/);
});
test('durable timing requires verified presentation/point gates and at least one actual executor',()=>{
 const e={...env,DATABASE_STARTUP_MODE:'verify',AI_RECEPTION_REPLY_TIMING_ENABLED:'true',AI_RECEPTION_AUTOMATIC_PRESENTATION_ENABLED:'true',
  AI_RECEPTION_PERSONALIZATION_MANAGEMENT_ENABLED:'true',AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED:'true'};
 assert.equal(validateAutomaticReceptionStartup(e,secret,()=>{}).timing,true);
 assert.equal(validateAutomaticReceptionStartup(env,secret,()=>{}).timing,false);
 for(const changed of [{AI_RECEPTION_AUTOMATIC_PRESENTATION_ENABLED:'false'},{AI_RECEPTION_PERSONALIZATION_MANAGEMENT_ENABLED:'false'},
  {AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED:'false'},{DATABASE_STARTUP_MODE:'legacy'},{AI_RECEPTION_AUTOMATIC_WEB_ENABLED:'false'}])
  assert.throws(()=>validateAutomaticReceptionStartup({...e,...changed},secret,()=>{}),/automatic_reply_timing_dependencies_required/);
});

const wechatEnv:NodeJS.ProcessEnv={AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED:'true',AI_RECEPTION_AUTOMATIC_WECHAT_MANAGEMENT_ENABLED:'true',
 AI_RECEPTION_AUTOMATIC_WECHAT_ENABLED:'true',AI_POINTS_ENABLED:'true',WECHAT_VERIFIED_INGRESS_ENABLED:'true',
 DATABASE_STARTUP_MODE:'verify',CHATWOOT_BASE_URL:'http://isolated-native:3000'};
test('WeChat management requires base management and receipt-only startup but no credentials/model',()=>{
 const e={...wechatEnv,AI_RECEPTION_AUTOMATIC_WECHAT_ENABLED:'false'};
 const c=validateAutomaticReceptionStartup(e,()=>{throw Error();},()=>{throw Error();});
 assert.equal(c.wechatManagement,true);assert.equal(c.wechat,false);assert.equal(c.callback,false);
 for(const wrong of [{AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED:'false'},{DATABASE_STARTUP_MODE:'legacy'},{DATABASE_STARTUP_MODE:undefined}])
  assert.throws(()=>validateAutomaticReceptionStartup({...e,...wrong},secret,()=>{}),/^Error: automatic_reception_dependencies_required$/);
});
test('WeChat execution requires scoped management, metering and verified ingress',()=>{
 for(const name of ['AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED','AI_RECEPTION_AUTOMATIC_WECHAT_MANAGEMENT_ENABLED','AI_POINTS_ENABLED','WECHAT_VERIFIED_INGRESS_ENABLED'])
  assert.throws(()=>validateAutomaticReceptionStartup({...wechatEnv,[name]:'false'},secret,()=>{}),/^Error: automatic_reception_dependencies_required$/);
});
test('WeChat-only startup resolves signed-native configuration, never website read token or bridge',()=>{
 const names:string[]=[];let models=0;
 const c=validateAutomaticReceptionStartup(wechatEnv,name=>{names.push(name);return secret(name);},()=>{models++;});
 assert.deepEqual(names,['REPLYNEST_AUTOMATIC_REPLY_SECRET']);assert.equal(models,1);
 assert.equal(c.wechat,true);assert.equal(c.web,false);assert.equal(c.callback,false);assert.equal(c.bridgeSecret,'');assert.equal(c.token,'');
 for(const wrong of [{CHATWOOT_BASE_URL:'http://isolated-native/private'},{}])
  assert.throws(()=>validateAutomaticReceptionStartup({...wechatEnv,...wrong},()=> 'short',()=>{}),/^Error: automatic_reception_configuration_invalid$/);
});

test('history-only recovery requires receipt management and signing key, but no model, points or sending credentials',()=>{
 const names:string[]=[];
 const e={...wechatEnv,AI_RECEPTION_AUTOMATIC_WECHAT_ENABLED:'false',AI_RECEPTION_WECHAT_HISTORY_ENABLED:'true',AI_POINTS_ENABLED:'false',WECHAT_VERIFIED_INGRESS_ENABLED:'false'};
 const c=validateAutomaticReceptionStartup(e,name=>{names.push(name);return secret(name);},()=>{assert.fail('history must never configure model');});
 assert.equal(c.wechatHistory,true);assert.equal(c.wechat,false);assert.equal(c.token,'');assert.equal(c.bridgeSecret,'');
 assert.deepEqual(names,['REPLYNEST_AUTOMATIC_REPLY_SECRET']);
 assert.throws(()=>validateAutomaticReceptionStartup({...e,AI_RECEPTION_AUTOMATIC_WECHAT_MANAGEMENT_ENABLED:'false'},secret,()=>{}),/dependencies_required/);
});
test('combined Web and WeChat startup validates both channels without duplicating model validation',()=>{
 let models=0;const c=validateAutomaticReceptionStartup({...env,...wechatEnv},secret,()=>{models++;});
 assert.equal(c.web,true);assert.equal(c.wechat,true);assert.equal(c.callback,true);assert.equal(models,1);
 assert.throws(()=>validateAutomaticReceptionStartup({...env,...wechatEnv},name=>name==='REPLYNEST_AUTOMATIC_REPLY_SECRET'?bridge:secret(name),()=>{}),/^Error: automatic_reception_configuration_invalid$/);
});
test('web requires management, authenticated callback and point accounting',()=>{
 for(const name of ['AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED','AI_RECEPTION_EVENT_CALLBACK_ENABLED','AI_POINTS_ENABLED']){
  assert.throws(()=>validateAutomaticReceptionStartup({...env,[name]:'false'},secret,()=>{}),/^Error: automatic_reception_dependencies_required$/);
 }
});
test('legacy draft callback only requires its independent bridge credential',()=>{
 const names:string[]=[];
 const c=validateAutomaticReceptionStartup({AI_RECEPTION_DRAFT_WORKER_ENABLED:'true',AI_RECEPTION_EVENT_CALLBACK_ENABLED:'true'},name=>{names.push(name);return bridge;},()=>{throw Error();});
 assert.deepEqual(names,['CHATWOOT_CALLBACK_SECRET']);assert.equal(c.callback,true);assert.equal(c.draftCallback,true);assert.equal(c.web,false);
});
test('web validates separate credentials, root origin and model without exposing details',()=>{
 let models=0;const c=validateAutomaticReceptionStartup(env,secret,()=>{models++;});
 assert.equal(c.origin,'http://isolated-native:3000');assert.equal(c.nativeSecret,native);assert.equal(models,1);
 const invalidOrigins=['ftp://local','http://local/path','http://local/?key=private','http://user:private@local','http://local/#private','not a URL'];
 for(const origin of invalidOrigins)assert.throws(()=>validateAutomaticReceptionStartup({...env,CHATWOOT_BASE_URL:origin},secret,()=>{}),/^Error: automatic_reception_configuration_invalid$/);
 for(const value of ['',bridge,'short',native+'\n'])assert.throws(()=>validateAutomaticReceptionStartup(env,name=>name==='REPLYNEST_AUTOMATIC_REPLY_SECRET'?value:secret(name),()=>{}),/^Error: automatic_reception_configuration_invalid$/);
 assert.throws(()=>validateAutomaticReceptionStartup(env,()=>{throw Error('private path /secret/key');},()=>{}),/^Error: automatic_reception_configuration_invalid$/);
 assert.throws(()=>validateAutomaticReceptionStartup(env,secret,()=>{throw Error('private model key');}),/^Error: automatic_reception_configuration_invalid$/);
});
