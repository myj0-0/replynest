import { exactObject, ExtensionError } from './extension-core.js';

export type AutomationPreview = { schema_version:1; name:string; timezone:'Asia/Shanghai'; trigger:'weekly'|'manual_sample'|'message_received'; slots:{weekdays:number[];time:string;assignee_ref:string}[]; keywords:string[]; semantic?:{labels:string[];min_confidence:number}; assignee_ref:string; statuses:('open'|'pending')[]; overwrite_assigned:boolean; max_actions:number };
export const rotationExample:AutomationPreview={schema_version:1,name:'排班预览 · 授权后可启用定时转派',timezone:'Asia/Shanghai',trigger:'weekly',slots:[{weekdays:[1,3,5,7],time:'00:00',assignee_ref:'客服A'},{weekdays:[2,4,6],time:'00:00',assignee_ref:'客服B'}],keywords:[],assignee_ref:'',statuses:['open','pending'],overwrite_assigned:false,max_actions:50};
const invalid=()=>{throw new ExtensionError('invalid_automation_preview',400);};
const label=(v:unknown,max=80)=>{if(typeof v!=='string'||!v.trim()||v.length>max) return invalid();return v.trim();};
export function validateAutomationPreview(raw:unknown):AutomationPreview {
  const d=exactObject(raw,['schema_version','name','timezone','trigger','slots','keywords','semantic','assignee_ref','statuses','overwrite_assigned','max_actions']);
  if(d.schema_version!==1||d.timezone!=='Asia/Shanghai'||!['weekly','manual_sample','message_received'].includes(String(d.trigger))||typeof d.overwrite_assigned!=='boolean'||!Number.isSafeInteger(d.max_actions)||Number(d.max_actions)<1||Number(d.max_actions)>100) return invalid();
  if(!Array.isArray(d.statuses)||!d.statuses.length||d.statuses.length>2||d.statuses.some(s=>!['open','pending'].includes(s))||new Set(d.statuses).size!==d.statuses.length) return invalid();
  if(!Array.isArray(d.keywords)||d.keywords.length>10||!Array.isArray(d.slots)||d.slots.length>7) return invalid();
  const keywords=d.keywords.map(k=>label(k,40));const seen=new Set<string>();
  let semantic:AutomationPreview['semantic'];
  if(d.semantic!==undefined){
   const s=exactObject(d.semantic,['labels','min_confidence']);
   if(!Array.isArray(s.labels)||!s.labels.length||s.labels.length>10||keywords.length||typeof s.min_confidence!=='number'||!Number.isFinite(s.min_confidence)||s.min_confidence<0.8||s.min_confidence>1)return invalid();
   const labels=s.labels.map(x=>label(x,30));
   if(new Set(labels).size!==labels.length||labels.includes('无法判断'))return invalid();
   semantic={labels,min_confidence:s.min_confidence};
  }
  const slots=d.slots.map(s=>{const x=exactObject(s,['weekdays','time','assignee_ref']);if(!Array.isArray(x.weekdays)||!x.weekdays.length||x.weekdays.length>7||typeof x.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(x.time)) return invalid();
    const weekdays=x.weekdays.map(n=>{if(!Number.isInteger(n)||n<1||n>7) return invalid();const k=`${n}:${x.time}`;if(seen.has(k))return invalid();seen.add(k);return n;});return {weekdays,time:x.time,assignee_ref:label(x.assignee_ref)};});
  if(d.trigger==='weekly'&&(!slots.length||d.assignee_ref!==''))return invalid();
  if(d.trigger!=='weekly'&&(slots.length||(!keywords.length&&!semantic)))return invalid();
  return {schema_version:1,name:label(d.name),timezone:'Asia/Shanghai',trigger:d.trigger as AutomationPreview['trigger'],slots,keywords,...(semantic?{semantic}:{}),assignee_ref:d.trigger!=='weekly'?label(d.assignee_ref):'',statuses:d.statuses as AutomationPreview['statuses'],overwrite_assigned:d.overwrite_assigned,max_actions:Number(d.max_actions)};
}

export function simulateAutomation(raw:unknown,rawSamples:unknown,instant:string,semanticMatches?:ReadonlyMap<string,boolean>) {
  const d=validateAutomationPreview(raw);
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(instant)||!Number.isFinite(Date.parse(instant)))return invalid();
  if(new Date(instant).toISOString()!==instant.replace(/(?<!\.\d{3})Z$/,'.000Z'))return invalid();
  if(!Array.isArray(rawSamples)||rawSamples.length>100) return invalid();
  const ids=new Set<string>();
  const samples=rawSamples.map(v=>{const x=exactObject(v,['id','text','status','assignee_ref']);const id=label(x.id);if(ids.has(id)||!['open','pending','resolved'].includes(String(x.status))||typeof x.text!=='string'||x.text.length>4000||(x.assignee_ref!==null&&(typeof x.assignee_ref!=='string'||x.assignee_ref.length>80)))return invalid();ids.add(id);return {id,text:x.text,status:String(x.status),assignee_ref:x.assignee_ref as string|null};});
  const shifted=new Date(Date.parse(instant)+8*3600000),day=shifted.getUTCDay()||7,time=shifted.toISOString().slice(11,16);
  const slot=d.slots.find(s=>s.weekdays.includes(day)&&s.time===time);
  const target=d.trigger==='weekly'?slot?.assignee_ref:d.assignee_ref;
  let count=0;
  const results=samples.map(s=>{
    let reason='would_assign';
    if(!target)reason='not_scheduled_now';
    else if(!d.statuses.includes(s.status as 'open'|'pending'))reason='status_excluded';
    else if(d.keywords.length&&!d.keywords.some(k=>s.text.toLowerCase().includes(k.toLowerCase())))reason='keyword_not_matched';
    else if(s.assignee_ref===target)reason='already_assigned';
    else if(s.assignee_ref&&!d.overwrite_assigned)reason='preserve_manual_assignment';
    else if(d.semantic&&!semanticMatches?.has(s.id))reason='semantic_requires_ai';
    else if(d.semantic&&semanticMatches?.get(s.id)!==true)reason='semantic_not_matched';
    else if(count>=d.max_actions)reason='action_limit';
    if(reason==='would_assign')count++;
    return {sample_id:s.id,reason,target:reason==='would_assign'?target:null};
  });
  const next_runs:{at:string;assignee_ref:string}[]=[];
  const midnight=Date.UTC(shifted.getUTCFullYear(),shifted.getUTCMonth(),shifted.getUTCDate());
  for(let i=0;i<8;i++){const date=new Date(midnight+i*86400000);for(const s of d.slots){if(!s.weekdays.includes(date.getUTCDay()||7))continue;const [h,m]=s.time.split(':').map(Number),at=new Date(date.getTime()+(h-8)*3600000+m*60000);if(at.getTime()>Date.parse(instant))next_runs.push({at:at.toISOString(),assignee_ref:s.assignee_ref});}}
  next_runs.sort((a,b)=>a.at.localeCompare(b.at));
  return {mode:'preview_only',executed:false,real_conversations_read:0,planned_count:count,results,next_runs:next_runs.slice(0,7),warning:'只处理手动样本；负责人为显示名称占位，未验证真实成员身份。未安装后台任务。'};
}
