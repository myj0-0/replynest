import {insightInput,parseInsightOutput,insightOutputDiagnostic,insightResponseFormat,validateInsightScope,INSIGHT_MAX_OUTPUT_TOKENS,type InsightScope,type InsightMessage,type InsightFact,type CustomerInsight} from './customer-insights-core.js';
import {parseAiUsage,type AiUsage} from './ai-points-core.js';

export type InsightJob=InsightScope&{jobId:string;lease:string};
export type InsightFailure={phase:'claim'|'authorization'|'history'|'budget'|'generation'|'settlement'|'output'|'save';code:string};
/** Server-only ports. Implementations MUST serialize grant/revision/daily-budget
 * checks in DB transactions; unique jobId reservation, bounded verified reads,
 * fenced saves and durable terminal state are required. Never wire this to the
 * old context/style grants or to an unverified/public message callback.
 */
export type InsightsPorts={
 enabled():boolean;
 claim():Promise<InsightJob|null>;
 authorized(job:InsightJob):Promise<boolean>;
 read(job:InsightJob):Promise<{rows:InsightMessage[];previous:InsightFact[];known:string[]}>;
 skipBatch?(job:InsightJob):Promise<boolean>;
 reserve(job:InsightJob,input:string,maxOutput:number):Promise<{ticket:string}|null>;
 // Persist calling state BEFORE provider I/O, with fresh grant + lease + budget
 // fences. An interrupted calling job is uncertain, never put back in pending.
 beginModel(job:InsightJob,ticket:string):Promise<boolean>;
 model(messages:{role:'system'|'user';content:string}[],maxOutput:number,format:ReturnType<typeof insightResponseFormat>):Promise<{text:string;usage:AiUsage}>;
 settle(job:InsightJob,ticket:string,usage:AiUsage|null,state:'known'|'not_called'|'unknown'):Promise<void|'known'|'not_called'|'unknown'>;
 save(job:InsightJob,result:CustomerInsight):Promise<boolean>;
 finish(job:InsightJob,state:'saved'|'revoked'|'budget_exhausted'|'rejected'|'uncertain'):Promise<void>;
 reportFailure?(failure:InsightFailure):void;
};
function usage(raw:unknown):AiUsage{
 const v=raw as AiUsage|null;
 return parseAiUsage({prompt_tokens:v?.input_tokens,completion_tokens:v?.output_tokens,prompt_tokens_details:{cached_tokens:v?.cached_input_tokens}});
}
/** No retry around model I/O. A timeout may have consumed provider tokens:
 * keep its budget reservation and terminal uncertain state for reconciliation.
 * Revocation after a call suppresses publication but does not erase real cost.
 */
export function createCustomerInsightsWorker(ports:InsightsPorts){
 let busy=false;
 return {runOne:async()=>{
  if(busy||!ports.enabled())return false;busy=true;
  let job:InsightJob|null=null,ticket:string|null=null,started=false,settled=false,actualUsage:AiUsage|null=null;
  let phase:InsightFailure['phase']='claim',outputCode:string|null=null;
  try{
   job=await ports.claim();if(!job)return false;
   const {jobId:_jobId,lease:_lease,...scope}=job;
   validateInsightScope(scope);
   if(![job.jobId,job.lease].every(v=>/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v)))throw Error('insights_job_invalid');
   const allowed=()=>ports.enabled()&&ports.authorized(job!);
   phase='authorization';
   if(!await allowed()){await ports.finish(job,'revoked');return true;}
   phase='history';const source=await ports.read(job);
   if(!source.rows.length&&ports.skipBatch){if(!await ports.skipBatch(job))await ports.finish(job,'revoked');return true;}
   const input=insightInput(scope,source.rows,source.previous,source.known);
   if(!await allowed()){await ports.finish(job,'revoked');return true;}
   const format=insightResponseFormat(input.evidence,input.currentEvidence);
   // Schema bytes also enter the conservative reservation before provider I/O.
   phase='budget';const reservation=await ports.reserve(job,JSON.stringify({messages:input.messages,response_format:format}),INSIGHT_MAX_OUTPUT_TOKENS);
   if(!reservation){await ports.finish(job,'budget_exhausted');return true;}
   ticket=reservation.ticket;
   if(!await allowed()||!await ports.beginModel(job,ticket)){
    await ports.settle(job,ticket,null,'not_called');settled=true;await ports.finish(job,'revoked');return true;
   }
   phase='generation';started=true;const result=await ports.model(input.messages,INSIGHT_MAX_OUTPUT_TOKENS,format);
   actualUsage=usage(result.usage);
   phase='settlement';await ports.settle(job,ticket,actualUsage,'known');settled=true;
   phase='output';outputCode=insightOutputDiagnostic(result.text,input.evidence,input.currentEvidence);
   const parsed=parseInsightOutput(result.text,input.evidence,input.currentEvidence);
   if(!await allowed()){await ports.finish(job,'revoked');return true;}
   // save is a transactional compare-and-swap: current grant, active customer
   // binding, job lease, generation and revision, not just the above read check.
   phase='save';if(!await ports.save(job,parsed)){await ports.finish(job,'revoked');return true;}
   await ports.finish(job,'saved');return true;
  }catch(error){
   const publicCodes=new Set(['insights_output_invalid','insights_history_unavailable','insights_history_scope_invalid','insights_source_binding_changed','insights_points_not_settled','insights_meter_settlement_conflict','qwen_unavailable','qwen_auth_failed','qwen_rate_limited','qwen_request_failed','qwen_usage_missing','qwen_invalid_response']);
   const raw=error instanceof Error?error.message:'',sql=(error as {code?:unknown})?.code;
   const code=phase==='output'&&outputCode&&outputCode!=='valid'?outputCode:publicCodes.has(raw)?raw:sql==='42501'?'storage_permission':sql==='23505'?'storage_conflict':sql==='22P02'?'storage_format':'operation_failed';
   try{ports.reportFailure?.({phase,code});}catch{/* diagnostics never replace cost settlement or terminal fencing */}
   if(!job)throw error;
   let uncertain=started&&!settled;
   if(ticket&&!settled){
    let actual:AiUsage|null=actualUsage;
    if(!actual)try{actual=usage((error as {usage?:unknown})?.usage);}catch{}
    const outcome=await ports.settle(job,ticket,actual,actual?'known':started?'unknown':'not_called');
    // The DB calling commit may have succeeded before its acknowledgement was
    // lost. Respect durable settlement state, not only the local started flag.
    if(outcome)uncertain=outcome==='unknown';
   }
   await ports.finish(job,uncertain?'uncertain':'rejected');return true;
  }finally{busy=false;}
 }};
}
