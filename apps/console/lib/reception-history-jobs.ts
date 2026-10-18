export const historyJobLabels:Record<string,string>={queued:'等待处理',reading:'读取已授权历史',prepared:'准备生成',reserved:'已预留点数',requesting:'正在生成',succeeded:'草稿待核对',failed:'未生成草稿',uncertain:'结果待核实'};
export const historyJobMessages:Record<string,string>={history_knowledge_disabled:'历史知识草稿生成尚未开放。',history_query_invalid:'任务查询参数不正确。',history_administrator_required:'请使用当前企业管理员账号操作。',history_authorization_required:'请先单独保存历史知识草稿用途授权。',history_knowledge_confirmation_required:'请确认整理历史聊天及消耗 AI 点数。',history_knowledge_rate_limited:'已有任务正在处理，或已达到每日5次上限。'};
export type HistoryJob={jobId:string;requestId:string;state:string;createdAt:string;documentId:string|null;billing:{state:string;chargedMicros:string|null;reservedMicros:string|null}};
export type HistoryJobsPage={items:HistoryJob[];canGenerate:boolean;nextCursor:string|null};
const uuid=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(s);
const micros=(s:unknown):s is string=>typeof s==='string'&&/^(0|[1-9]\d{0,18})$/.test(s)&&BigInt(s)<=9223372036854775807n;
export function formatHistoryPoints(value:string){if(!micros(value))throw Error('invalid_points');const n=BigInt(value);return `${n/1000000n}${n%1000000n?'.'+(n%1000000n).toString().padStart(6,'0').replace(/0+$/,''):''}`;}
export function parseHistoryJobsPage(v:any):HistoryJobsPage{
 const fail=()=>{throw Error('任务状态或费用暂时无法确认，请刷新核实，不要重复创建任务。');};
 if(!v||typeof v.canGenerate!=='boolean'||!Array.isArray(v.items)||v.items.length>25||v.nextCursor!==null&&(typeof v.nextCursor!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(v.nextCursor)))return fail();
 const items=v.items.map((r:any)=>{
  if(!r||!uuid(r.jobId)||!uuid(r.requestId)||!Object.hasOwn(historyJobLabels,r.state)||typeof r.createdAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(r.createdAt)||!Number.isFinite(Date.parse(r.createdAt))||r.documentId!==null&&!uuid(r.documentId)||r.documentId!==null&&r.state!=='succeeded')return fail();
  const b=r.billing;if(!b||!['not_requested','reserved','charged','not_charged','review_required'].includes(b.state))return fail();
  if(b.state==='charged'? !micros(b.chargedMicros)||b.reservedMicros!==null:
   b.state==='not_charged'? b.chargedMicros!=='0'||b.reservedMicros!==null:
   b.state==='reserved'? b.chargedMicros!==null||!micros(b.reservedMicros):b.chargedMicros!==null||b.reservedMicros!==null)return fail();
  return {jobId:r.jobId,requestId:r.requestId,state:r.state,createdAt:r.createdAt,documentId:r.documentId,billing:{state:b.state,chargedMicros:b.chargedMicros,reservedMicros:b.reservedMicros}};
 });
 if(new Set(items.map((r:HistoryJob)=>r.jobId)).size!==items.length)return fail();
 return {items,canGenerate:v.canGenerate,nextCursor:v.nextCursor};
}
