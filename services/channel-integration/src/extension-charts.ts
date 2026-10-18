import type {Chart} from './extension-core.js';
export type ChartSummary={key:string;record_count:number;included_count:number;omitted_groups:number;points:{label:string;value:number;count:number}[]};
// Input is selected server-side by tenant, app and immutable definition version.
// No expressions, property paths, SQL, URLs, or model calls are evaluated here.
export function summarizeCharts(charts:Chart[],records:{data:Record<string,unknown>}[]):ChartSummary[]{
 return charts.map(chart=>{
  const groups=new Map<string,{total:number;count:number}>();let included=0;
  for(const {data} of records){
   const group=data[chart.group_by];
   if((typeof group!=='string'&&typeof group!=='boolean')||group==='')continue;
   const value=chart.metric==='count'?1:data[chart.value_field!];
   if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e12)continue;
   const label=String(group),row=groups.get(label)??{total:0,count:0};row.total+=value;row.count++;groups.set(label,row);included++;
  }
  const points=[...groups].map(([label,row])=>({label,value:chart.metric==='average'?row.total/row.count:row.total,count:row.count}));
  // Date strings are ISO calendar days: retain the latest 30 dates in ascending order.
  // Bars retain the 30 highest values, with deterministic label ordering for ties.
  if(chart.type==='line')points.sort((a,b)=>a.label.localeCompare(b.label));
  else points.sort((a,b)=>b.value-a.value||a.label.localeCompare(b.label));
  return {key:chart.key,record_count:records.length,included_count:included,omitted_groups:Math.max(0,points.length-30),points:chart.type==='line'?points.slice(-30):points.slice(0,30)};
 });
}
