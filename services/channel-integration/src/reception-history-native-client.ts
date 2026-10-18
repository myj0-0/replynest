import {createHash,createHmac,randomBytes} from 'node:crypto';
import {RECEPTION_HISTORY_DISCLOSURES,type ReceptionHistoryPurpose} from './reception-history-learning.js';
export type HistoryCursor=Readonly<{created_at:string;message_id:string}>;
export type NativeHistoryRequest=Readonly<{account_id:string;purpose:ReceptionHistoryPurpose;grant_id:string;as_of:string;contact_ids:readonly string[];cursor:HistoryCursor|null}>;
export type NativeInsightsHistoryRequest=Omit<NativeHistoryRequest,'purpose'>&Readonly<{purpose:'customerInsights';after:HistoryCursor|null;event_ids:readonly string[]}>;
export type NativeHistoryRow=Readonly<{account_id:string;contact_id:string;inbox_id:string;conversation_id:string;message_id:string;created_at:string;direction:'incoming'|'outgoing';author_kind:'customer'|'human';text:string}>;
export type NativeHistoryPage=Readonly<{scanned:number;next_cursor:HistoryCursor|null;scan_cursor?:HistoryCursor|null;event_seen_ids?:readonly string[];rows:readonly NativeHistoryRow[]}>;
const bytes=2*1024*1024;
type Purpose=ReceptionHistoryPurpose|'customerInsights';
type PurposeRequest<P extends Purpose>=P extends 'customerInsights'?NativeInsightsHistoryRequest:Omit<NativeHistoryRequest,'purpose'>&Readonly<{purpose:P}>;
const exact=(v:Record<string,unknown>,names:string[])=>Object.keys(v).sort().join(',')===[...names].sort().join(',');
function object(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v as Record<string,unknown>;}
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const time=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,23)===v.slice(0,23);
const earlier=(a:HistoryCursor,b:HistoryCursor)=>a.created_at<b.created_at||a.created_at===b.created_at&&BigInt(a.message_id)<BigInt(b.message_id);
function cursor(v:unknown,asOf:string):HistoryCursor|null{
 if(v===null)return null;const c=object(v);
 if(!exact(c,['created_at','message_id'])||!id(c.message_id)||!time(c.created_at)||c.created_at>asOf||Date.parse(c.created_at)<Date.parse(asOf)-30*86400000)throw Error();
 return Object.freeze({created_at:c.created_at,message_id:c.message_id});
}
// JSON.parse silently accepts duplicate keys, including escaped duplicates. Walk
// valid JSON's string/object boundaries before trusting any authority envelope.
export function parseUniqueReceptionJson(text:string):unknown{
 const value=JSON.parse(text),stack:Array<Set<string>|null>=[];let nodes=0;
 for(let i=0;i<text.length;i++){
  const ch=text[i];if(ch==='{'||ch==='['){stack.push(ch==='{'?new Set():null);if(stack.length>8||++nodes>5000)throw Error();}
  else if(ch==='}'||ch===']')stack.pop();
  else if(ch==='"'){
   const start=i++;while(i<text.length){if(text[i]==='\\'){i+=2;continue;}if(text[i]==='"')break;i++;}
   const end=i;let next=i+1;while(/\s/.test(text[next]??'')&&next<text.length)next++;
   if(text[next]===':'){const keys=stack.at(-1),key=JSON.parse(text.slice(start,end+1));if(!keys||keys.has(key))throw Error();keys.add(key);if(++nodes>5000)throw Error();}
  }
 }
 return value;
}
function validatePurposeRequest<P extends Purpose>(input:unknown,nowMs:number,purposes:readonly P[]):PurposeRequest<P> {
 const v=object(input);
 const incremental=v.purpose==='customerInsights';
 if(!exact(v,['account_id','purpose','grant_id','as_of','contact_ids','cursor',...(incremental?['after','event_ids']:[])])||!id(v.account_id)||typeof v.purpose!=='string'||!purposes.includes(v.purpose as P)||
  typeof v.grant_id!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v.grant_id)||!time(v.as_of)||
  !Number.isSafeInteger(nowMs)||Date.parse(v.as_of)>nowMs+5000||Date.parse(v.as_of)<nowMs-300000||
  !Array.isArray(v.contact_ids)||v.contact_ids.length>8||v.contact_ids.some(c=>!id(c))||new Set(v.contact_ids).size!==v.contact_ids.length||['context','customerInsights'].includes(v.purpose)&&!v.contact_ids.length)throw Error();
 let extra={};if(incremental){
  if(!Array.isArray(v.event_ids)||v.event_ids.length>100||v.event_ids.some(c=>!id(c))||new Set(v.event_ids).size!==v.event_ids.length)throw Error();
  const a=v.after===null?null:object(v.after);
  if(a&&(!exact(a,['created_at','message_id'])||!id(a.message_id)||!time(a.created_at)||a.created_at>v.as_of))throw Error();
  extra={after:a?Object.freeze({...a}):null,event_ids:Object.freeze([...v.event_ids])};
 }
 return Object.freeze({account_id:v.account_id,purpose:v.purpose as P,grant_id:v.grant_id,as_of:v.as_of,
  contact_ids:Object.freeze([...v.contact_ids] as string[]),cursor:cursor(v.cursor,v.as_of),...extra}) as PurposeRequest<P>;
}
export function validateNativeHistoryRequest(input:unknown,nowMs:number):NativeHistoryRequest{
 return validatePurposeRequest(input,nowMs,Object.keys(RECEPTION_HISTORY_DISCLOSURES) as ReceptionHistoryPurpose[]);
}
export function validateInsightsHistoryRequest(input:unknown,nowMs:number):NativeInsightsHistoryRequest{
 return validatePurposeRequest(input,nowMs,['customerInsights']);
}
/** Read-only RPC with fixed route, exact signed body, bounded response and one
 * deadline. No credentials/provider/model endpoint; caller owns consent checks.
 */
type ClientOptions={origin:string;secret:string;enabled?:()=>boolean;fetcher?:typeof fetch;now?:()=>number};
function createPurposeHistoryClient<P extends Purpose>(options:ClientOptions,path:string,purposes:readonly P[]){
 const origin=new URL(options.origin);
 if(!['http:','https:'].includes(origin.protocol)||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash||
  typeof options.secret!=='string'||Buffer.byteLength(options.secret)<32||Buffer.byteLength(options.secret)>65536||/[\0\r\n]/.test(options.secret))throw Error('invalid_reception_history_client');
 const enabled=options.enabled??(()=>false),fetcher=options.fetcher??fetch,now=options.now??Date.now;
 return {page:async(input:PurposeRequest<P>):Promise<{outcome:'ready';page:NativeHistoryPage}|{outcome:'rejected'|'unavailable'}>=>{
  if(!enabled())return {outcome:'rejected'};
  let request:PurposeRequest<P>;try{request=validatePurposeRequest(input,now(),purposes);}catch{return {outcome:'rejected'};}
  const body=JSON.stringify(request),stamp=String(now()),nonce=randomBytes(16).toString('hex'),controller=new AbortController();
  if(!/^\d{13}$/.test(stamp))return {outcome:'rejected'};
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('history_deadline'));},2000);});
   const operation=(async()=>{
    const r=await fetcher(origin.origin+path,{method:'POST',redirect:'error',signal:controller.signal,headers:{'content-type':'application/json',accept:'application/json','x-forwarded-proto':'https',
     'x-automatic-timestamp':stamp,'x-automatic-nonce':nonce,'x-automatic-signature':createHmac('sha256',options.secret).update(`${path}\n${stamp}\n${nonce}\n${body}`).digest('hex')},body});
    if(r.status!==200||!r.body)throw Error();const reader=r.body.getReader(),parts:Uint8Array[]=[];let size=0;
    const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
    let text:string;
    try{for(;;){if(controller.signal.aborted)throw Error();const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>bytes)throw Error();parts.push(p.value);}
     text=new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(parts));
    }finally{controller.signal.removeEventListener('abort',cancel);cancel();reader.releaseLock();}
    const v=object(parseUniqueReceptionJson(text!));
    const incremental=request.purpose==='customerInsights',insight=request as NativeInsightsHistoryRequest;
    if(!exact(v,['state','request_sha256','account_id','purpose','grant_id','as_of','scanned','next_cursor','rows',...(incremental?['scan_cursor','event_seen_ids']:[])])||v.state!=='ready'||
     v.request_sha256!==createHash('sha256').update(body).digest('hex')||v.account_id!==request.account_id||v.purpose!==request.purpose||v.grant_id!==request.grant_id||v.as_of!==request.as_of||
     !Number.isInteger(v.scanned)||Number(v.scanned)<0||Number(v.scanned)>200||!Array.isArray(v.rows)||v.rows.length>Number(v.scanned))throw Error();
    const next=cursor(v.next_cursor,request.as_of),scan=incremental?cursor(v.scan_cursor,request.as_of):null;
    if(next&&(v.scanned!==200||request.cursor&&!(incremental?earlier(request.cursor,next):earlier(next,request.cursor))))throw Error();
    if(incremental&&((v.scanned===0)!==(scan===null)||next&&JSON.stringify(next)!==JSON.stringify(scan)||scan&&request.cursor&&!earlier(request.cursor,scan)))throw Error();
    if(incremental&&(!Array.isArray(v.event_seen_ids)||v.event_seen_ids.length>100||new Set(v.event_seen_ids).size!==v.event_seen_ids.length||v.event_seen_ids.some(v=>!id(v)||!insight.event_ids.includes(v))))throw Error();
    const seen=new Set<string>();let previous=request.cursor;const rows:NativeHistoryRow[]=[];
    for(const raw of v.rows){const row=object(raw);
     if(!exact(row,['account_id','contact_id','inbox_id','conversation_id','message_id','created_at','direction','author_kind','text'])||row.account_id!==request.account_id||
      !['contact_id','inbox_id','conversation_id','message_id'].every(k=>id(row[k]))||!time(row.created_at)||row.created_at>request.as_of||Date.parse(row.created_at)<Date.parse(request.as_of)-30*86400000||
      request.contact_ids.length&&!request.contact_ids.includes(String(row.contact_id))||
      !(row.direction==='incoming'&&row.author_kind==='customer'||row.direction==='outgoing'&&row.author_kind==='human')||request.purpose==='style'&&row.author_kind!=='human'||
      typeof row.text!=='string'||!row.text.trim()||[...row.text].length>2000||Buffer.byteLength(row.text)>8000||row.text.includes('\0')||Buffer.from(row.text).toString('utf8')!==row.text||seen.has(String(row.message_id)))throw Error();
     const position={created_at:row.created_at,message_id:String(row.message_id)};
     if(incremental){
      if(previous&&!earlier(previous,position)||scan&&earlier(scan,position)||insight.after&&!earlier(insight.after,position)&&!insight.event_ids.includes(String(row.message_id)))throw Error();
     }else if(previous&&!earlier(position,previous)||next&&earlier(position,next))throw Error();
     previous=position;seen.add(String(row.message_id));rows.push(Object.freeze({...row}) as NativeHistoryRow);
    }
    if(!enabled())throw Error();
    return {outcome:'ready',page:Object.freeze({scanned:Number(v.scanned),next_cursor:next,...(incremental?{scan_cursor:scan,event_seen_ids:Object.freeze([...(v.event_seen_ids as string[])])}:{}),rows:Object.freeze(rows)})} as const;
   })();return await Promise.race([operation,deadline]);
  }catch{return {outcome:'unavailable'};}
  finally{if(timer)clearTimeout(timer);controller.abort();}
 }};
}
export function createReceptionHistoryNativeClient(options:ClientOptions){
 return createPurposeHistoryClient(options,'/internal/saas_sso/reception_history/page',Object.keys(RECEPTION_HISTORY_DISCLOSURES) as ReceptionHistoryPurpose[]);
}
/** Independent fixed route and purpose; old context/style grants are rejected. */
export function createCustomerInsightsHistoryClient(options:ClientOptions){
 return createPurposeHistoryClient(options,'/internal/saas_sso/customer_insights_history/page',['customerInsights']);
}
