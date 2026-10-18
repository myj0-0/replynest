/** Bounded administrator-only history task receipts. Never returns transcripts,
 * provider diagnostics, prompts, identity bindings or model credentials. */
import type {Pool} from 'pg';
import {authenticateAutomaticAdministrator} from './automatic-reception-auth.js';
import {initialAiPrices} from './ai-points-core.js';
export const historyJobStates=['queued','reading','prepared','reserved','requesting','succeeded','failed','uncertain'] as const;
const uuid=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(s);
const stamp=(s:unknown):s is string=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(s)&&Number.isFinite(Date.parse(s));
const amount=(s:unknown):s is string=>typeof s==='string'&&/^(0|[1-9]\d{0,18})$/.test(s)&&BigInt(s)<=9223372036854775807n;
export type HistoryJobsQuery={cursor?:string;requestId?:string};
export function validateHistoryJobsQuery(params:URLSearchParams):HistoryJobsQuery{
 if([...params.keys()].some(k=>!['cursor','requestId'].includes(k))||params.getAll('cursor').length>1||params.getAll('requestId').length>1||params.has('cursor')&&params.has('requestId'))throw Error('history_query_invalid');
 const requestId=params.get('requestId')??undefined,cursor=params.get('cursor')??undefined;
 if(requestId!==undefined&&!uuid(requestId))throw Error('history_query_invalid');
 if(cursor!==undefined)decodeHistoryCursor(cursor);
 return {...(cursor?{cursor}:{}),...(requestId?{requestId}:{})};
}
export function decodeHistoryCursor(cursor:string):{at:string;id:string}{
 if(typeof cursor!=='string'||cursor.length>256||!/^[A-Za-z0-9_-]+$/.test(cursor))throw Error('history_query_invalid');
 let v:any;try{v=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{throw Error('history_query_invalid');}
 if(!v||typeof v!=='object'||Object.keys(v).sort().join(',')!=='at,id'||!stamp(v.at)||!uuid(v.id)||Buffer.from(JSON.stringify(v)).toString('base64url')!==cursor)throw Error('history_query_invalid');
 return {at:v.at,id:v.id};
}
export type HistoryJobReceipt={jobId:string;requestId:string;state:typeof historyJobStates[number];createdAt:string;documentId:string|null;
 billing:{state:'not_requested'|'reserved'|'charged'|'not_charged'|'review_required';chargedMicros:string|null;reservedMicros:string|null}};
export function historyJobReceipt(row:any):HistoryJobReceipt{
 if(!uuid(row.job_id)||!uuid(row.request_id)||!stamp(row.created_at_text)||!historyJobStates.includes(row.state)||row.document_id!==null&&!uuid(row.document_id))throw Error('history_status_invalid');
 let billing:HistoryJobReceipt['billing']={state:'review_required',chargedMicros:null,reservedMicros:null};
 if(row.call_id===null&&row.attempted_at===null&&row.state!=='uncertain')billing={state:'not_requested',chargedMicros:null,reservedMicros:null};
 else if(row.receipt_call_id===row.call_id&&uuid(row.call_id)&&amount(row.charged_micros)&&amount(row.reserved_micros)&&BigInt(row.charged_micros)<=BigInt(row.reserved_micros)){
  if(row.receipt_status==='succeeded'&&amount(row.cost_nano_cny)&&amount(row.input_tokens)&&amount(row.output_tokens)&&amount(row.cached_input_tokens)&&BigInt(row.cached_input_tokens)<=BigInt(row.input_tokens))billing={state:'charged',chargedMicros:row.charged_micros,reservedMicros:null};
  else if(row.receipt_status==='reserved'&&row.state!=='uncertain')billing={state:'reserved',chargedMicros:null,reservedMicros:row.reserved_micros};
  else if(row.receipt_status==='failed'&&row.charged_micros==='0'&&amount(row.cost_nano_cny))billing={state:'not_charged',chargedMicros:'0',reservedMicros:null};
 }
 return {jobId:row.job_id,requestId:row.request_id,state:row.state,createdAt:row.created_at_text,documentId:row.state==='succeeded'?row.document_id:null,billing};
}
/** Cursor reads at most 26 indexed tenant rows; no total count/all-tenant scan.
 * Generation may be off while existing receipts remain readable. */
export async function listHistoricalKnowledgeJobs(db:Pick<Pool,'connect'>,token:string,tenant:string,query:HistoryJobsQuery={},canGenerate=false){
 const validated=validateHistoryJobsQuery(new URLSearchParams(query)),cursor=validated.cursor?decodeHistoryCursor(validated.cursor):undefined;
 const c=await db.connect();try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s';SET LOCAL lock_timeout='500ms'");
  const auth=await authenticateAutomaticAdministrator(c,token,{requireNativeAccount:false});
  if(!auth||auth.tenant_id!==tenant)throw Error('history_administrator_required');
  const rows=(await c.query(`SELECT j.job_id,j.request_id,j.state,j.document_id,j.call_id,j.attempted_at,
   to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at_text,
   a.call_id receipt_call_id,a.status receipt_status,a.charged_micros::text,a.reserved_micros::text,a.cost_nano_cny::text,
   a.input_tokens::text,a.output_tokens::text,a.cached_input_tokens::text
   FROM reception_history_knowledge_jobs j LEFT JOIN ai_usage_calls a ON a.call_id=j.call_id AND a.tenant_id=j.tenant_id
    AND a.request_key=j.request_key AND a.feature='studio' AND a.model=$2
   WHERE j.tenant_id=$1 ${validated.requestId?'AND j.request_id=$3':cursor?'AND (j.created_at,j.job_id)<($3::timestamptz,$4::uuid)':''}
   ORDER BY j.created_at DESC,j.job_id DESC LIMIT 26`,[tenant,initialAiPrices.text.model,...(validated.requestId?[validated.requestId]:cursor?[cursor.at,cursor.id]:[])])).rows;
  const items=rows.slice(0,25).map(historyJobReceipt),last=items.at(-1);
  await c.query('COMMIT');return {items,canGenerate,nextCursor:rows.length>25&&last?Buffer.from(JSON.stringify({at:last.createdAt,id:last.jobId})).toString('base64url'):null};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
