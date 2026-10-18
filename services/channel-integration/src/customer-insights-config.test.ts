import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCustomerInsightsStartup} from './customer-insights-config.js';
const env={AI_CUSTOMER_INSIGHTS_ENABLED:'true',DATABASE_STARTUP_MODE:'verify',AI_POINTS_ENABLED:'true',AI_RECEPTION_EVENT_CALLBACK_ENABLED:'true',CHATWOOT_BASE_URL:'http://native:3000'};
const keys:Record<string,string>={REPLYNEST_AUTOMATIC_REPLY_SECRET:'native-synthetic-key-000000000000000000',CHATWOOT_CALLBACK_SECRET:'callback-synthetic-key-000000000000000',CHATWOOT_API_ACCESS_TOKEN:'synthetic-token'};
test('disabled purpose resolves no secrets/model and starts no legacy capability',()=>{
 let calls=0;const result=validateCustomerInsightsStartup({},()=>{calls++;throw Error();},()=>{calls++;throw Error();});assert.equal(result.enabled,false);assert.equal(calls,0);assert.equal(result.secret,'');
});
test('enabled purpose requires verified schema, points and callback but no send/style grant',()=>{
 const result=validateCustomerInsightsStartup(env,k=>keys[k],()=>{});assert.equal(result.enabled,true);assert.equal(result.origin,'http://native:3000');assert.equal(result.shared,false);
 for(const key of ['DATABASE_STARTUP_MODE','AI_POINTS_ENABLED','AI_RECEPTION_EVENT_CALLBACK_ENABLED'])assert.throws(()=>validateCustomerInsightsStartup({...env,[key]:'false'},k=>keys[k],()=>{}),/dependencies/);
 assert.throws(()=>validateCustomerInsightsStartup({AI_CUSTOMER_INSIGHTS_ENABLED:'yes'},()=>undefined,()=>{}),/flag_invalid/);
});
test('bad server origin/key/token/model fail with a fixed non-sensitive error',()=>{
 for(const change of [{CHATWOOT_BASE_URL:'https://native/path'},{CHATWOOT_BASE_URL:'http://user:secret@native/'}])assert.throws(()=>validateCustomerInsightsStartup({...env,...change},k=>keys[k],()=>{}),/customer_insights_configuration_invalid/);
 const badKeys:Record<string,string>[]=[{...keys,CHATWOOT_API_ACCESS_TOKEN:''},{...keys,REPLYNEST_AUTOMATIC_REPLY_SECRET:'short'},{...keys,CHATWOOT_CALLBACK_SECRET:keys.REPLYNEST_AUTOMATIC_REPLY_SECRET}];
 for(const bad of badKeys)assert.throws(()=>validateCustomerInsightsStartup(env,k=>bad[k],()=>{}),/configuration_invalid/);
 assert.throws(()=>validateCustomerInsightsStartup(env,k=>keys[k],()=>{throw Error('private model credential');}),/configuration_invalid/);
});
test('shared purpose routing requires existing verified ingress rather than an arbitrary callback',()=>{
 assert.throws(()=>validateCustomerInsightsStartup({...env,SHARED_WECHAT_DELIVERY_ENABLED:'true'},k=>keys[k],()=>{}),/shared_ingress/);
 assert.equal(validateCustomerInsightsStartup({...env,SHARED_WECHAT_DELIVERY_ENABLED:'true',WECHAT_VERIFIED_INGRESS_ENABLED:'true'},k=>keys[k],()=>{}).shared,true);
});
