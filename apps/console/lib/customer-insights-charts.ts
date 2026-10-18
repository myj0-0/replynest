import {insightPreferenceCategories,insightProfileLabels,insightTopicLabels,type InsightsProfiles,type InsightsTopics} from './customer-insights';

export type InsightPieSlice={key:string;label:string;count:number;share:number;coverage:number;color:string};
const colors=['#1688ef','#14a692','#805ad5','#ed9b20','#df6686','#377db0','#60a534','#bc731f','#6778cc'];
const english:Record<string,string>={consultation:'Pre-sales',onboarding:'Getting started',usage:'Product usage',shipping:'Shipping',refund:'After-sales',billing:'Plans and pricing',complaint:'Feedback',integration:'Integrations',other:'Other',
 product_info:'Product information',setup_help:'Getting started',integration_help:'Integrations',shipping_speed:'Shipping time',after_sales:'After-sales help',pricing_cost:'Pricing',concise_reply:'Concise replies',detailed_reply:'Detailed guidance',evening_contact:'Evening contact',written_contact:'Text contact',phone_contact:'Phone contact',human_support:'Human assistance',other_explicit_need:'Other explicit needs'};
function slices(rows:Array<{key:string;label:string;count:number;percent:number}>,en:boolean):InsightPieSlice[]{
 const positive=rows.filter(r=>r.count>0).sort((a,b)=>b.count-a.count||a.key.localeCompare(b.key));
 const total=positive.reduce((sum,r)=>sum+r.count,0);
 return positive.map((r,i)=>({...r,label:en?english[r.key]:r.label,share:r.count/total*100,coverage:r.percent,color:colors[i%colors.length]}));
}
export function topicPie(data:InsightsTopics,en=false){return slices(data.topics.map(t=>({key:t.topic,label:insightTopicLabels[t.topic],count:t.count,percent:t.percent})),en);}
// Profile categories overlap. Pie area uses category counts, NOT customer coverage.
export function profilePie(data:InsightsProfiles,preference:boolean,en=false){
 return slices(data.categories.filter(c=>insightPreferenceCategories.has(c.category)===preference).map(c=>({key:c.category,label:insightProfileLabels[c.category],count:c.count,percent:c.percent})),en);
}
export function piePath(start:number,share:number){
 if(!Number.isFinite(start)||!Number.isFinite(share)||start<0||start>100||share<=0||share>100)throw Error('invalid_pie_segment');
 const point=(percent:number)=>{const radians=(percent/100*360-90)*Math.PI/180;return `${(100+86*Math.cos(radians)).toFixed(6)} ${(100+86*Math.sin(radians)).toFixed(6)}`;};
 if(share===100)return 'M 100 14 A 86 86 0 1 1 100 186 A 86 86 0 1 1 100 14 Z';
 return `M 100 100 L ${point(start)} A 86 86 0 ${share>50?1:0} 1 ${point(start+share)} Z`;
}
