import test from 'node:test';
import assert from 'node:assert/strict';
import {exampleDefinition,validateDefinition,definitionHash,type Chart} from './extension-core.js';
import {summarizeCharts} from './extension-charts.js';
import {appCapabilities,capabilityVersion,capabilityCatalog} from './extension-capabilities.js';
import {validateGeneration} from './extension-qwen.js';
const chart:Chart={key:'amounts',title:'金额统计',type:'bar',group_by:'priority',metric:'sum',value_field:'amount'};
test('legacy normalization and hashes unchanged; chart manifest exact',()=>{
 assert.deepEqual(validateDefinition(exampleDefinition),exampleDefinition);
 const d={...exampleDefinition,charts:[chart]},normalized=validateDefinition(d);
 assert.deepEqual(normalized.charts,[chart]);assert.notEqual(definitionHash(d),definitionHash(exampleDefinition));
 assert.equal(capabilityCatalog.capabilities.find(c=>c.id==='ui.chart')?.status,'available');
 const envelope={kind:'app',capability_version:capabilityVersion,definition:d,required_capabilities:appCapabilities(d)};
 assert.equal(validateGeneration(envelope).kind,'app');
 assert.throws(()=>validateGeneration({...envelope,required_capabilities:appCapabilities(exampleDefinition)}),/capability_manifest_mismatch/);
});
test('reject chart code, data sources, bad fields, duplicate IDs, excessive charts and invalid type combinations',()=>{
 for(const c of [{...chart,sql:'select * from customers'},{...chart,url:'https://example.com'},{...chart,group_by:'tenant_id'},{...chart,group_by:'amount'},{...chart,value_field:'subject'},{...chart,type:'pie'},{...chart,type:'line'},{...chart,metric:'median'},{...chart,metric:'count'},{...chart,value_field:undefined},{...chart,key:'constructor'}]) assert.throws(()=>validateDefinition({...exampleDefinition,charts:[c]}));
 assert.throws(()=>validateDefinition({...exampleDefinition,charts:[chart,chart]}));
 assert.throws(()=>validateDefinition({...exampleDefinition,charts:[1,2,3,4].map(n=>({...chart,key:`c${n}`}))}));
 assert.doesNotThrow(()=>validateDefinition({...exampleDefinition,charts:[{key:'n',title:'数量',type:'bar',group_by:'priority',metric:'count'}]}));
});
test('count/sum/average, negative and zero values, missing and invalid values',()=>{
 const records=[{priority:'A',amount:10},{priority:'A',amount:-4},{priority:'B',amount:0},{priority:'A'},{amount:50},{priority:'B',amount:'9'}].map(data=>({data}));
 assert.deepEqual(summarizeCharts([chart],records)[0],{key:'amounts',record_count:6,included_count:3,omitted_groups:0,points:[{label:'A',value:6,count:2},{label:'B',value:0,count:1}]});
 assert.equal(summarizeCharts([{...chart,metric:'average'}],records)[0].points[0].value,3);
 const {value_field:_,...count}=chart;assert.equal(summarizeCharts([{...count,metric:'count'}],records)[0].included_count,5);
 assert.deepEqual(summarizeCharts([chart],[])[0].points,[]);
});
test('large group sets explicitly truncated, chronological lines and boolean groups',()=>{
 const rows=Array.from({length:40},(_,i)=>({data:{priority:`g${i}`,amount:i}}));
 const r=summarizeCharts([chart],rows)[0];assert.equal(r.omitted_groups,10);assert.equal(r.points.length,30);assert.equal(r.record_count,40);assert.equal(r.points[0].value,39);
 const days=Array.from({length:40},(_,i)=>({data:{day:new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10)}})).reverse();
 const line:Chart={key:'days',title:'趋势',type:'line',group_by:'day',metric:'count'};
 const d={...exampleDefinition,fields:[...exampleDefinition.fields,{key:'day',label:'日期',type:'date' as const,required:false}],charts:[line]};assert.doesNotThrow(()=>validateDefinition(d));
 const trend=summarizeCharts([line],days)[0];assert.equal(trend.points[0].label,'2026-01-11');assert.equal(trend.points.at(-1)?.label,'2026-02-09');assert.equal(trend.omitted_groups,10);
 assert.equal(summarizeCharts([{...line,type:'bar'}],[{data:{day:false}}])[0].points[0].label,'false');
});
