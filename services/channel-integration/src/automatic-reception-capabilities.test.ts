import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticRuntimeChannels,readAutomaticAuthorizedChannels} from './automatic-reception-capabilities.js';
const keys=['AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED','AI_RECEPTION_AUTOMATIC_WEB_ENABLED','AI_RECEPTION_EVENT_CALLBACK_ENABLED',
 'AI_RECEPTION_AUTOMATIC_WECHAT_MANAGEMENT_ENABLED','AI_RECEPTION_AUTOMATIC_WECHAT_ENABLED','AI_POINTS_ENABLED','WECHAT_VERIFIED_INGRESS_ENABLED','DATABASE_STARTUP_MODE'];
test('runtime capabilities are gated by channel dependencies, not a legacy draft switch',()=>{
 const original=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{
  for(const k of keys)delete process.env[k];assert.deepEqual(automaticRuntimeChannels(),[]);
  Object.assign(process.env,{AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED:'true',AI_RECEPTION_AUTOMATIC_WEB_ENABLED:'true',
   AI_RECEPTION_EVENT_CALLBACK_ENABLED:'true',AI_POINTS_ENABLED:'true'});assert.deepEqual(automaticRuntimeChannels(),['web_chat']);
  Object.assign(process.env,{AI_RECEPTION_AUTOMATIC_WEB_ENABLED:'false',AI_RECEPTION_AUTOMATIC_WECHAT_MANAGEMENT_ENABLED:'true',
   AI_RECEPTION_AUTOMATIC_WECHAT_ENABLED:'true',WECHAT_VERIFIED_INGRESS_ENABLED:'true',DATABASE_STARTUP_MODE:'verify'});
  assert.deepEqual(automaticRuntimeChannels(),['wechat_official_account','shared_wechat']);
  for(const key of ['AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED','AI_RECEPTION_AUTOMATIC_WECHAT_MANAGEMENT_ENABLED','AI_RECEPTION_AUTOMATIC_WECHAT_ENABLED','AI_POINTS_ENABLED','WECHAT_VERIFIED_INGRESS_ENABLED','DATABASE_STARTUP_MODE']){
   const value=process.env[key];process.env[key]='false';assert.deepEqual(automaticRuntimeChannels(),[]);process.env[key]=value;
  }
 }finally{for(const k of keys)if(original[k]===undefined)delete process.env[k];else process.env[k]=original[k];}
});
test('disabled capabilities never query experimental tables',async()=>{
 assert.deepEqual(await readAutomaticAuthorizedChannels({query:async()=>assert.fail('no SQL')} as any,'tenant-A',[]),[]);
});
test('WeChat needs its own current scope and cannot inherit web authorization or model-injected channels',async()=>{
 let queries=0,scope:any={channels:['shared_wechat','unsupported']};
 const db={query:async(sql:string,params:any[])=>{queries++;assert.equal(params[0],'tenant-A');
  if(sql.startsWith('SELECT g.')){assert.match(sql,/g\.account_id=t\.chatwoot_account_id::text/);return {rows:[{authorization_id:'primary-A'}]};}
  assert.deepEqual(params,['tenant-A','primary-A','wechat-automatic-send-v1']);assert.match(sql,/enabled AND consent_version/);return {rows:scope?[scope]:[]};}} as any;
 assert.deepEqual(await readAutomaticAuthorizedChannels(db,'tenant-A',['web_chat']),['web_chat']);assert.equal(queries,1);
 assert.deepEqual(await readAutomaticAuthorizedChannels(db,'tenant-A',['web_chat','wechat_official_account','shared_wechat']),['web_chat','shared_wechat']);
 scope=null;assert.deepEqual(await readAutomaticAuthorizedChannels(db,'tenant-A',['wechat_official_account','shared_wechat']),[]);
 assert.deepEqual(await readAutomaticAuthorizedChannels({query:async()=>({rows:[]})} as any,'tenant-B',['web_chat']),[]);
});
