import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exampleDefinition,validateDefinition} from './extension-core.js';
import {appCapabilities,capabilityVersion} from './extension-capabilities.js';
import {validateGeneration} from './extension-qwen.js';
import {marketContent,marketKind} from './template-market-core.js';
import {intentMessages,validateIntentResult} from './studio-intent-core.js';

const intent={labels:['退款','咨询']};
const workbench={title:'客服工作台',theme:'violet',density:'compact',list_width:260,details_width:360,tools_position:'after_profile'};
test('new fields roundtrip; generator manifest exact; unknown privileges rejected',()=>{
 const d=validateDefinition({...exampleDefinition,intent,workbench});
 assert.equal(d.workbench?.theme,'violet');assert(appCapabilities(d).includes('ai.classify_conversation'));
 assert.equal(validateGeneration({kind:'app',definition:d,required_capabilities:appCapabilities(d),capability_version:capabilityVersion}).kind,'app');
 for(const value of [{...workbench,html:'<script/>'},{...workbench,list_width:900},{...workbench,theme:'url(https://evil)'},{...workbench,hide_send:true}])assert.throws(()=>validateDefinition({...exampleDefinition,workbench:value}));
 assert.throws(()=>validateDefinition({...exampleDefinition,intent:{labels:['退款','退款']}}));assert.throws(()=>validateDefinition({...exampleDefinition,intent:{...intent,auto_assign:true}}));
});
test('classification excludes private/activity/attachments and bounds text, masking common contacts',()=>{
 const raw=[{id:1,message_type:0,private:false,content:'联系 a@example.com 13812345678',sender:{name:'PRIVATE NAME'}},{id:2,message_type:0,private:true,content:'SECRET NOTE'},{id:3,message_type:2,private:false,content:'ACTIVITY'},{id:4,message_type:1,content:'UNKNOWN PRIVACY'}];
 const text=JSON.stringify(intentMessages(raw));assert(!text.includes('SECRET'));assert(!text.includes('ACTIVITY'));assert(!text.includes('UNKNOWN'));assert(!text.includes('example.com'));assert(!text.includes('138123'));assert(!text.includes('PRIVATE NAME'));
 const bounded=intentMessages(Array.from({length:30},(_,i)=>({id:i,private:false,message_type:0,content:'字'.repeat(3000)})));assert(bounded.length<=20);assert(bounded.reduce((n,m)=>n+m.text.length,0)<=6000);
});
test('model output accepts only configured labels; low confidence abstains; no actions',()=>{
 assert.equal(validateIntentResult({label:'退款',confidence:0.59},intent.labels).label,'无法判断');
 for(const r of [{label:'转派管理员',confidence:1},{label:'退款',confidence:Infinity},{label:'退款',confidence:1,action:'assign'}])assert.throws(()=>validateIntentResult(r,intent.labels));
});
test('market studio validates canonical definition, one draft per listing, no grants',()=>{
 const content=[{title:'示例',body:JSON.stringify({...exampleDefinition,intent,workbench})}];
 assert.equal(marketContent('studio',content).length,1);
 assert.throws(()=>marketContent('studio',[...content,...content]));assert.throws(()=>marketContent('studio',[{title:'坏模板',body:JSON.stringify({...exampleDefinition,enabled:true})}]));assert.throws(()=>marketKind('all'));
 assert.equal(marketContent('knowledge',[{title:'文档',body:'正文'}])[0].body,'正文');
});
