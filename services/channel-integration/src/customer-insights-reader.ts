import type {createCustomerInsightsStore} from './customer-insights-store.js';
import type {InsightJob} from './customer-insights-worker.js';
import {insightInput,INSIGHT_MAX_MESSAGES,INSIGHT_MAX_INPUT_CHARS,type InsightFact,type InsightMessage} from './customer-insights-core.js';
import {redactReceptionHistoryText} from './reception-history-reader.js';
import type {NativeInsightsHistoryRequest,NativeHistoryPage,HistoryCursor} from './reception-history-native-client.js';
type Store=Pick<ReturnType<typeof createCustomerInsightsStore>,'authorized'|'readContext'|'sealEvidence'>;
type Port={page(input:NativeInsightsHistoryRequest):Promise<{outcome:'ready';page:NativeHistoryPage}|{outcome:'rejected'|'unavailable'}>};
const nativeId=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const timestamp=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,23)===v.slice(0,23);
const earlier=(a:HistoryCursor,b:HistoryCursor)=>a.created_at<b.created_at||a.created_at===b.created_at&&BigInt(a.message_id)<BigInt(b.message_id);
/** ASC bounded history batches. Progress is SEALED here, but is committed only
 * with saved output (or a proven empty batch); no tx spans native/model I/O.
 * Event IDs rescue late commits older than the cursor. Receipts keep them from
 * being repeatedly billed. Older-only batches cannot invent a current issue.
 */
export function createCustomerInsightsReader(store:Store,native:Port,enabled:()=>boolean=()=>false){
 return {read:async(job:InsightJob):Promise<{rows:InsightMessage[];previous:InsightFact[];known:string[]} >=>{
  if(!enabled())throw Error('insights_reader_disabled');
  const context=await store.readContext(job),fingerprint=JSON.stringify([context.contacts,context.known,context.after]);
  const fresh=async()=>{
   if(!enabled()||!await store.authorized(job))throw Error('insights_history_revoked');
   const current=await store.readContext(job);
   if(JSON.stringify([current.contacts,current.known,current.after])!==fingerprint)throw Error('insights_source_binding_changed');
  };
  let cursor:HistoryCursor|null=null,progress:HistoryCursor|null=context.after,scanned=0,chars=0,more=false;
  const selected:InsightMessage[]=[],seen=new Set<string>(),events=new Set(context.eventMessageIds),ack=new Set<string>();
  const {jobId:_id,lease:_lease,...scope}=job;
  outer:for(let page=0;page<3;page++){
   await fresh();const response=await native.page({account_id:job.accountId,purpose:'customerInsights',grant_id:job.grantId,
    as_of:context.asOf,contact_ids:context.contacts,cursor,after:context.after,event_ids:context.eventMessageIds});
   await fresh();if(response.outcome!=='ready')throw Error('insights_history_unavailable');
   const p=response.page;if(!p||!Number.isInteger(p.scanned)||p.scanned<0||p.scanned>200||!Array.isArray(p.rows)||p.rows.length>p.scanned||scanned+p.scanned>600)throw Error('insights_history_unavailable');scanned+=p.scanned;
   const validCursor=(c:HistoryCursor)=>!!c&&nativeId(c.message_id)&&timestamp(c.created_at)&&c.created_at<=context.asOf&&Date.parse(c.created_at)>=Date.parse(context.asOf)-30*86400000;
   const next=p.next_cursor,scan=p.scan_cursor,eventSeen=p.event_seen_ids;
   if(!Array.isArray(eventSeen)||eventSeen.length>100||new Set(eventSeen).size!==eventSeen.length||eventSeen.some(id=>!nativeId(id)||!events.has(id)))throw Error('insights_history_event_receipt_invalid');
   if(scan===undefined||(p.scanned===0)!==(scan===null)||scan&&(!validCursor(scan)||cursor&&!earlier(cursor,scan))||
    next!==null&&(!validCursor(next)||p.scanned!==200||JSON.stringify(next)!==JSON.stringify(scan)))throw Error('insights_history_cursor_invalid');
   let previous=cursor;
   for(const r of p.rows){
    if(!r||Object.keys(r).sort().join(',')!=='account_id,author_kind,contact_id,conversation_id,created_at,direction,inbox_id,message_id,text'||
     r.account_id!==job.accountId||![r.contact_id,r.inbox_id,r.conversation_id,r.message_id].every(nativeId)||!context.contacts.includes(r.contact_id)||seen.has(r.message_id)||
     !timestamp(r.created_at)||r.created_at>context.asOf||Date.parse(r.created_at)<Date.parse(context.asOf)-30*86400000||
     typeof r.text!=='string'||!r.text.trim()||[...r.text].length>2000||Buffer.byteLength(r.text)>8000||r.text.includes('\0')||Buffer.from(r.text).toString('utf8')!==r.text||
     !(r.direction==='incoming'&&r.author_kind==='customer'||r.direction==='outgoing'&&r.author_kind==='human'))throw Error('insights_history_scope_invalid');
    const position={created_at:r.created_at,message_id:r.message_id};
    if(previous&&!earlier(previous,position)||scan&&earlier(scan,position)||context.after&&!earlier(context.after,position)&&!events.has(r.message_id))throw Error('insights_history_cursor_invalid');
    previous=position;seen.add(r.message_id);
    const text=redactReceptionHistoryText(r.text,context.known);
    if(!text.trim()||text.length>2000)throw Error('insights_source_limit');
    if(chars+text.length>INSIGHT_MAX_INPUT_CHARS||selected.length>=INSIGHT_MAX_MESSAGES){more=true;break outer;}
    const candidate:InsightMessage={tenantId:job.tenantId,accountId:job.accountId,customerId:job.customerId,conversationId:r.conversation_id,messageId:r.message_id,
     createdAt:r.created_at,direction:r.direction,author:r.author_kind,private:false,text};
    // JSON escaping can exceed the byte budget before the character budget.
    // Keep that valid message for the next batch instead of rejecting all input.
    try{insightInput(scope,[...selected,candidate],context.previous,context.known);}
    catch(error){if(selected.length&&(error as Error).message==='insights_input_limit'){more=true;break outer;}throw error;}
    selected.push(candidate);chars+=text.length;
    if(!progress||earlier(progress,position))progress=position;if(events.has(r.message_id))ack.add(r.message_id);
   }
   if(scan&&(!progress||earlier(progress,scan)))progress=scan;
   if(!next){progress={created_at:context.asOf,message_id:'9223372036854775807'};for(const id of eventSeen)ack.add(id);break;}
   cursor=next;more=page===2;
  }
  if(!progress)throw Error('insights_history_cursor_invalid');
  if(selected.length)insightInput(scope,selected,context.previous,context.known);
  await fresh();if(!await store.sealEvidence(job,selected,context.asOf,{cursor:progress,hasMore:more,eventIds:[...ack]}))throw Error('insights_history_revoked');
  return {rows:selected,previous:context.previous,known:context.known};
 }};
}
