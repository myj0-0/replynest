import test from 'node:test';
import assert from 'node:assert/strict';
import {rotationExample,simulateAutomation,validateAutomationPreview} from './automation-preview.js';
import {rulePermissions,validateRule} from './automation-rule-core.js';
import {previewRouting,type RoutingClassifier} from './automation-routing.js';
import {validateGeneration} from './extension-qwen.js';
import {capabilityVersion} from './extension-capabilities.js';
import {knowledgeSelection,studioKnowledge} from './studio-knowledge.js';
const member='00000000-0000-4000-8000-000000000001';
const semantic={...rotationExample,trigger:'manual_sample' as const,slots:[],assignee_ref:member,max_actions:10,semantic:{labels:['退款咨询'],min_confidence:0.85}};
const instant='2026-10-08T16:00:00Z';
const samples=[{id:'1',text:'钱能退回吗',status:'open',assignee_ref:null},{id:'2',text:'多少钱',status:'open',assignee_ref:null},{id:'3',text:'退款',status:'open',assignee_ref:'人工客服'}];
test('semantic schema is explicit and disjoint from literal keywords',()=>{
 assert.deepEqual(validateRule(semantic).semantic,semantic.semantic);
 for(const raw of [{...semantic,keywords:['退款']},{...semantic,semantic:{...semantic.semantic,min_confidence:0.7}},{...semantic,semantic:{...semantic.semantic,labels:['无法判断']}},{...semantic,semantic:{...semantic.semantic,send:true}}])assert.throws(()=>validateAutomationPreview(raw));
 assert.equal(simulateAutomation(semantic,samples,instant).planned_count,0);
 assert.deepEqual(rulePermissions(semantic),['conversation.read_for_plan','automation.schedule_plan','conversation.semantic_routing','ai.points.consume']);
 assert(rulePermissions({...rotationExample,keywords:['退款']},true).includes('conversation.keyword_routing'));
});
test('AI manifest must declare semantic routing and cannot grant execution',()=>{
 const envelope={kind:'automation_preview',capability_version:capabilityVersion,definition:semantic,required_capabilities:['ai.semantic_routing']};
 assert.equal(validateGeneration(envelope).kind,'automation_preview');
 assert.throws(()=>validateGeneration({...envelope,required_capabilities:['preview.keyword_routing']}));
 assert.throws(()=>validateGeneration({...envelope,required_capabilities:['ai.semantic_routing','conversation.assign']}));
});
test('semantic sample preview requires confirmation; preserves assignees and never writes',async()=>{
 let calls=0;
 const classifier:RoutingClassifier=async(tenant,s,text)=>{calls++;assert.equal(tenant,'tenant-a');assert.deepEqual(s,semantic.semantic);return {label:text==='钱能退回吗'?'退款咨询':'无法判断',confidence:0.9,matched:text==='钱能退回吗'};};
 await assert.rejects(previewRouting('tenant-a',semantic,samples,instant,false,classifier),/semantic_confirmation_required/);assert.equal(calls,0);
 const result=await previewRouting('tenant-a',semantic,samples,instant,true,classifier);
 assert.equal(calls,2);assert.equal(result.planned_count,1);assert.equal(result.executed,false);assert.equal(result.real_conversations_read,0);
 assert.deepEqual(result.results.map(r=>r.reason),['would_assign','semantic_not_matched','preserve_manual_assignment']);
 await assert.rejects(previewRouting('tenant-a',semantic,Array.from({length:11},(_,i)=>({...samples[0],id:String(i)})),instant,true,classifier),/semantic_sample_limit/);
 await assert.rejects(previewRouting('tenant-a',semantic,samples,instant,true,async()=>{throw Error('provider_failed');}),/provider_failed/);
});
test('knowledge generation selection is explicit, bounded, tenant scoped and rejects missing sources',async()=>{
 assert.deepEqual(knowledgeSelection(undefined,false),[]);
 assert.throws(()=>knowledgeSelection([member],false),/knowledge_confirmation_required/);
 for(const ids of [[],[member,member],['not-id'],Array.from({length:4},()=>member)])assert.throws(()=>knowledgeSelection(ids,true));
 let reads=0;
 const db={query:async(sql:string,values:unknown[])=>{reads++;assert.deepEqual(values,['tenant-a',[member]]);assert.match(sql,/tenant_id=\$1/);assert.match(sql,/status='active'/);assert.match(sql,/scan_status IN/);assert.match(sql,/left\(content,1200\)/);return {rows:[{document_id:member,title:'发货',version:2,content:'两个工作日'}]};}};
 const rows=await studioKnowledge(db as never,'tenant-a',[member]);assert.equal(rows[0].content,'两个工作日');assert.equal(reads,1);
 await assert.rejects(studioKnowledge({query:async()=>({rows:[]})} as never,'tenant-a',[member]),/knowledge_source_unavailable/);
});
