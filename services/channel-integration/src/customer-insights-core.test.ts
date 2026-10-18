import test from 'node:test';
import assert from 'node:assert/strict';
import {CUSTOMER_INSIGHTS_CONSENT,insightInput,parseInsightOutput,insightOutputDiagnostic,insightResponseFormat,validateInsightsSettings,insightBudgetDay,canReserveInsightBudget,insightTopicRollup,type InsightScope,type InsightMessage} from './customer-insights-core.js';
const scope:InsightScope={tenantId:'a',accountId:'2',customerId:'bbbbbbbb-1111-4111-8111-aaaaaaaaaaaa',conversationId:'3',grantId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',generation:1,revision:2};
const row:InsightMessage={tenantId:'a',accountId:'2',customerId:scope.customerId,conversationId:'3',messageId:'101',createdAt:'2026-10-11T10:00:00Z',direction:'incoming',author:'customer',private:false,text:'请简洁回复，一般几天发货？'};
const output={long_term:[{text:'客户明确希望简洁回复',evidence_ids:['101'],category:'concise_reply'}],current_issue:{text:'询问发货时效',evidence_ids:['101']},topic:'shipping'};
test('strict provider schema binds source strings, current-session enum and finite categories',()=>{
 const f=insightResponseFormat(new Set(['100','101']),new Set(['101']));
 assert.equal(f.type,'json_schema');assert.equal(f.json_schema.strict,true);
 const schema=f.json_schema.schema;assert.equal(schema.additionalProperties,false);
 assert.deepEqual(schema.properties.long_term.items.properties.evidence_ids.items,{type:'string',enum:['100','101']});
 assert.deepEqual(schema.properties.current_issue.properties!.evidence_ids.items,{type:'string',enum:['101']});
 assert.equal(schema.properties.long_term.items.additionalProperties,false);
 assert.deepEqual(schema.properties.long_term.items.required,['text','evidence_ids','category']);
 assert.ok(!JSON.stringify(f).includes('uniqueItems'),'provider-unsupported uniqueness stays in the local parser');
});
test('historical-only provider schema forces null current issue and rejects foreign or unsafe source scope',()=>{
 assert.deepEqual(insightResponseFormat(new Set(['101']),new Set()).json_schema.schema.properties.current_issue,{type:'null'});
 for(const [allowed,current] of [[[],[]],[['101'],['999']],[['0'],[]],[['9223372036854775808'],[]]] as string[][][])assert.throws(()=>insightResponseFormat(new Set(allowed),new Set(current)));
});

test('output diagnostics emit finite codes, never provider prose or source IDs; parser remains strict',()=>{
 const allowed=new Set(['101','100']),current=new Set(['101']);
 assert.equal(insightOutputDiagnostic(JSON.stringify(output),allowed,current),'valid');
 const numeric={...output,current_issue:{text:'不会记录到日志的内容',evidence_ids:[101]}};
 assert.equal(insightOutputDiagnostic(JSON.stringify(numeric),allowed,current),'output_evidence_type');
 assert.throws(()=>parseInsightOutput(JSON.stringify(numeric),allowed,current),/insights_output_invalid/);
 assert.equal(insightOutputDiagnostic('private provider prose sk-secret',allowed,current),'output_json');
 assert.equal(insightOutputDiagnostic(JSON.stringify({...output,unknown_secret_key:'private'}),allowed,current),'output_document_shape');
 assert.equal(insightOutputDiagnostic(JSON.stringify({...output,long_term:[{text:'希望简洁回复',evidence_ids:['101']}]}),allowed,current),'output_category');
 assert.equal(insightOutputDiagnostic(JSON.stringify({...output,current_issue:{text:'旧会话',evidence_ids:['100']}}),allowed,current),'output_current_scope');
});
test('model contract explicitly requires exact string-array evidence and plain JSON',()=>{
 const input=insightInput(scope,[row]);
 assert.deepEqual(JSON.parse(input.messages[1].content).messages.map((m:{id:string})=>m.id),['101']);
 for(const clause of ['1 至 4 个字符串的数组','保留双引号','不能转成数字','单个字符串','空数组','不能重复','不加 Markdown'])assert.ok(input.messages[0].content.includes(clause));
 const allowed=input.evidence,current=input.currentEvidence;
 for(const evidence_ids of [[101],'101',[],{},['101','101'],['999'],['101','101','101','101','101']]){
  assert.throws(()=>parseInsightOutput(JSON.stringify({...output,current_issue:{text:'询问发货',evidence_ids}}),allowed,current),/output_invalid/);
 }
});
test('numeric-looking evidence stays exact beyond JavaScript integer precision; never coerce it',()=>{
 const id='9223372036854775807',input=insightInput(scope,[{...row,messageId:id}]);
 const value={long_term:[{text:'希望简洁回复',evidence_ids:[id],category:'concise_reply'}],current_issue:{text:'询问发货',evidence_ids:[id]},topic:'shipping'};
 assert.equal(parseInsightOutput(JSON.stringify(value),input.evidence,input.currentEvidence).current_issue!.evidence_ids[0],id);
 assert.throws(()=>parseInsightOutput(JSON.stringify({...value,current_issue:{...value.current_issue,evidence_ids:[Number(id)]}}),input.evidence,input.currentEvidence),/output_invalid/);
});
test('separate current consent, admin-only and precise daily-budget input',()=>{
 const raw={enabled:true,daily_budget_points:'10.123456',confirmed:true,consent_version:CUSTOMER_INSIGHTS_CONSENT,revision:0};
 assert.equal(validateInsightsSettings(raw,'tenant_admin').budgetMicros,10123456);
 for(const role of ['agent','supervisor','owner'])assert.throws(()=>validateInsightsSettings(raw,role),/admin_required/);
 assert.throws(()=>validateInsightsSettings(raw,'tenant_admin',true),/admin_required/);
 for(const change of [{confirmed:false},{consent_version:'context-v1'},{enabled:'true'},{revision:-1},{extra:true}])assert.throws(()=>validateInsightsSettings({...raw,...change},'tenant_admin'));
 for(const budget of ['0','0.000001','10000.000001','1e3','-1','Infinity','10.1234567',' 10',10])assert.throws(()=>validateInsightsSettings({...raw,daily_budget_points:budget},'tenant_admin'));
});
test('daily budget includes held and uncertain calls, with a fixed China billing day',()=>{
 assert.equal(insightBudgetDay('2026-10-11T15:59:59Z'),'2026-10-11');assert.equal(insightBudgetDay('2026-10-11T16:00:00Z'),'2026-10-12');
 assert.equal(canReserveInsightBudget(1000000,200000,300000,500000),true);
 assert.equal(canReserveInsightBudget(1000000,200000,300000,500001),false);
 assert.throws(()=>canReserveInsightBudget(1000000,-1,0,10));
});
test('same-customer cross-conversation merge, privacy masking and no customer IDs in prompt',()=>{
 const prior=[{text:'曾咨询安装方法',evidence_ids:['90'],category:'setup_help' as const}];
 const input=insightInput(scope,[{...row,conversationId:'4',messageId:'100',text:'之前问过安装方法'},row],prior);
 assert.equal(parseInsightOutput(JSON.stringify({...output,long_term:prior}),input.evidence,input.currentEvidence).long_term[0].text,'曾咨询安装方法');
 const masked=insightInput(scope,[{...row,text:'客户名，请回复 test@example.invalid，电话13800138000，密码：secret123'}],[],['客户名']);
 const prompt=JSON.stringify(masked.messages);
 for(const secret of ['客户名','test@example.invalid','13800138000','secret123',scope.customerId,scope.grantId])assert.ok(!prompt.includes(secret));
});
test('foreign tenant/customer, private/system/AI rows and oversize batches fail closed',()=>{
 for(const extra of [{tenantId:'b'},{accountId:'9'},{customerId:'cccccccc-1111-4111-8111-aaaaaaaaaaaa'},{private:true},{author:'ai'},{direction:'activity'},{messageId:'0'},{text:'x'.repeat(2001)}])assert.throws(()=>insightInput(scope,[{...row,...extra} as any]));
 assert.throws(()=>insightInput(scope,[row,row]));
 assert.throws(()=>insightInput(scope,Array.from({length:41},(_,i)=>({...row,messageId:String(i+1)}))));
 assert.throws(()=>insightInput(scope,Array.from({length:8},(_,i)=>({...row,messageId:String(i+1),text:'字'.repeat(1800)}))));
});
test('strict sourced output, current summary cannot cite another conversation or sensitive identity',()=>{
 const input=insightInput(scope,[{...row,conversationId:'4',messageId:'100'},row]);
 assert.equal(parseInsightOutput(JSON.stringify(output),input.evidence,input.currentEvidence).topic,'shipping');
 for(const changed of [{...output,topic:'富裕女性'},{...output,extra:true},{...output,current_issue:{text:'旧会话',evidence_ids:['100']}},{...output,long_term:[{text:'客户年龄30岁',evidence_ids:['101']}]},{...output,long_term:[{text:'没有证据',evidence_ids:['999']}]}])assert.throws(()=>parseInsightOutput(JSON.stringify(changed),input.evidence,input.currentEvidence));
});
test('charts count existing latest customer results once and never need model output',()=>{
 const other='cccccccc-1111-4111-8111-aaaaaaaaaaaa';
 const rows=[{customerId:scope.customerId,updatedAt:'2026-10-10T01:00:00Z',topic:'billing' as const},{customerId:scope.customerId,updatedAt:'2026-10-11T01:00:00Z',topic:'shipping' as const},{customerId:other,updatedAt:'2026-10-11T01:00:00Z',topic:'shipping' as const}];
 const result=insightTopicRollup(rows,'2026-10-10T00:00:00Z');assert.equal(result.total,2);assert.equal(result.topics.find(t=>t.topic==='shipping')?.percent,100);assert.equal(result.topics.find(t=>t.topic==='billing')?.count,0);
});
test('duplicate JSON keys cannot replace a sourced field or topic during parsing',()=>{
 const input=insightInput(scope,[row]);
 for(const bad of [JSON.stringify(output).replace('"topic":"shipping"','"topic":"billing","topic":"shipping"'),
  JSON.stringify(output).replace('"text":"询问发货时效"','"text":"错误来源","text":"询问发货时效"')])
  assert.throws(()=>parseInsightOutput(bad,input.evidence,input.currentEvidence),/output_invalid/);
});
test('historical batches without current-session sources can only produce long-term facts',()=>{
 const input=insightInput(scope,[{...row,conversationId:'4'}]);assert.equal(input.currentEvidence.size,0);
 const parsed=parseInsightOutput(JSON.stringify({...output,current_issue:null}),input.evidence,input.currentEvidence);assert.equal(parsed.current_issue,null);
 assert.throws(()=>parseInsightOutput(JSON.stringify(output),input.evidence,input.currentEvidence));
});
test('profile categories require a finite sourced explicit category or null, never arbitrary traits',()=>{
 const input=insightInput(scope,[row]);
 for(const category of ['concise_reply','shipping_speed',null]){
  const parsed=parseInsightOutput(JSON.stringify({...output,long_term:[{...output.long_term[0],category}]}),input.evidence,input.currentEvidence);
  assert.equal(parsed.long_term[0].category,category);
 }
 for(const v of [{text:'希望简洁回复',evidence_ids:['101']},{...output.long_term[0],category:'age_30'},
  {...output.long_term[0],category:true},{...output.long_term[0],category:'concise_reply',evidence_ids:['999']}]){
  assert.throws(()=>parseInsightOutput(JSON.stringify({...output,long_term:[v]}),input.evidence,input.currentEvidence));
 }
 const legacy=insightInput(scope,[row],[{text:'曾咨询上手',evidence_ids:['90']}]);
 assert.ok(legacy.messages[1].content.includes('曾咨询上手'));
 // Legacy local stored facts may be read, but fresh model output must classify
 // explicitly or use null; viewing charts never invents a missing category.
});
