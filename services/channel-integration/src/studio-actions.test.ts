import test from 'node:test';
import assert from 'node:assert/strict';
import {studioEndpoint,actionPayload} from './studio-actions.js';
import {validateDefinition,exampleDefinition} from './extension-core.js';
import {appCapabilities} from './extension-capabilities.js';
test('external actions have no model-selected URL/credentials; whitelist existing fields',()=>{
 const d={...exampleDefinition,actions:[{key:'sync',title:'同步事项',kind:'http',fields:['subject']}]};
 const v=validateDefinition(d);assert(appCapabilities(v).includes('http.request'));
 assert.deepEqual(actionPayload(v.actions![0],{subject:'售后',amount:5,hidden:'secret'}),{subject:'售后'});
 for(const a of [{...d.actions[0],endpoint:'https://example.com'},{...d.actions[0],fields:['tenant_id']},{...d.actions[0],fields:[]}])assert.throws(()=>validateDefinition({...d,actions:[a]}));
 for(const url of ['http://example.com','https://127.0.0.1','https://10.0.0.1','https://169.254.169.254','https://user:password@example.com','https://example.com:8443','https://example.com/?token=secret','https://[::1]'])assert.throws(()=>studioEndpoint(url));
 assert.equal(studioEndpoint('https://api.example.com/events').href,'https://api.example.com/events');
});
test('marketing action creates a normalized draft request, not a send command',()=>{
 const d=validateDefinition({...exampleDefinition,actions:[{key:'promotion',title:'促销',kind:'campaign',name_field:'subject',content_field:'priority'}]});
 assert(appCapabilities(d).includes('message.broadcast'));
 assert.deepEqual(actionPayload(d.actions![0],{subject:'活动',priority:'优先'}),{name:'活动',content:'优先',channel:'wechat_official_account',audience_filter:{mode:'all',tags:[]}});
 assert.throws(()=>validateDefinition({...d,actions:[{...d.actions![0],name_field:'amount'}]}));
});
