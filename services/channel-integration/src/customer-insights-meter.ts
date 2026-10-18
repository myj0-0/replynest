import type {Pool} from 'pg';
import {reserveAiPoints,settleAiPoints,AiPointsError} from './ai-points.js';
import {initialAiPrices,priceAiUsage,parseAiUsage,type AiUsage} from './ai-points-core.js';
import {INSIGHT_MAX_OUTPUT_TOKENS} from './customer-insights-core.js';
import type {InsightJob} from './customer-insights-worker.js';
import type {createCustomerInsightsStore} from './customer-insights-store.js';
type Store=ReturnType<typeof createCustomerInsightsStore>;
type Db=Pick<Pool,'connect'|'query'>;
type PointPorts={reserve:typeof reserveAiPoints;settle:typeof settleAiPoints};
const key=(j:InsightJob)=>`customer-insights:${j.jobId}`;
/** One ledger request key per durable job. Points and purpose-budget transactions
 * are separate (and recoverable); neither spans a model/native network request.
 * The DB ledger, not a cached provider result, is authoritative for actual cost.
 */
export function createCustomerInsightsMeter(db:Db,store:Store,points:PointPorts={reserve:reserveAiPoints,settle:settleAiPoints}){
 const call=async(j:InsightJob)=>(await db.query(`SELECT * FROM ai_usage_calls WHERE tenant_id=$1 AND request_key=$2`,[j.tenantId,key(j)])).rows[0];
 const check=(r:any,estimate?:number)=>{
  if(!r||r.feature!=='copilot'||r.model!==initialAiPrices.text.model||estimate!==undefined&&Number(r.reserved_micros)!==estimate)throw Error('insights_meter_receipt_invalid');
 };
 const settle=async(j:InsightJob,ticket:string,usage:AiUsage|null,state:'known'|'not_called'|'unknown'):Promise<'known'|'not_called'|'unknown'>=>{
  const b=await store.budgetState(j,ticket);if(!b)throw Error('insights_budget_fence');
  const r=await call(j);if(r)check(r,b.estimatedMicros);
  if(b.aiCallId&&b.aiCallId!==r?.call_id)throw Error('insights_meter_receipt_invalid');
  if(state==='not_called'&&['calling','unknown'].includes(b.state))state='unknown';
  if(state==='unknown'){
   // Never settle a timeout as failed/free. Exact-purpose reserves are excluded
   // from generic 15-minute abandonment until their cost can be reconciled.
   await store.settleBudget(j,ticket,'unknown');return 'unknown';
  }
  if(state==='known'){
   if(!usage||!r)throw Error('insights_meter_usage_missing');
   const valid=parseAiUsage({prompt_tokens:usage.input_tokens,completion_tokens:usage.output_tokens,prompt_tokens_details:{cached_tokens:usage.cached_input_tokens}});
   await points.settle(j.tenantId,r.call_id,valid,true,undefined,db);
   const receipt=await call(j);check(receipt,b.estimatedMicros);
   if(receipt.status!=='succeeded'||Number(receipt.input_tokens)!==valid.input_tokens||Number(receipt.output_tokens)!==valid.output_tokens||
    Number(receipt.cached_input_tokens)!==valid.cached_input_tokens||Number(receipt.charged_micros)!==Math.min(Number(receipt.reserved_micros),priceAiUsage(valid,receipt.price_snapshot).point_micros))throw Error('insights_meter_settlement_conflict');
   await store.settleBudget(j,ticket,'known');return 'known';
  }
  if(r){await points.settle(j.tenantId,r.call_id,undefined,false,'insights_model_not_called',db);
   const receipt=await call(j);if(receipt.status!=='failed'||Number(receipt.charged_micros)!==0)throw Error('insights_meter_settlement_conflict');}
  await store.settleBudget(j,ticket,'not_called');return 'not_called';
 };
 return {settle,reserve:async(j:InsightJob,input:string,maxOutput:number)=>{
  if(typeof input!=='string'||!input.length||Buffer.byteLength(input)>64000||maxOutput!==INSIGHT_MAX_OUTPUT_TOKENS)throw Error('insights_meter_input_invalid');
  const bound=Buffer.byteLength(input)+4096,estimate=priceAiUsage({input_tokens:bound,output_tokens:maxOutput,cached_input_tokens:0},initialAiPrices.text).point_micros;
  const ticket=await store.reserveBudget(j,estimate);if(!ticket)return null;
  let reserved:string|undefined;
  try{reserved=await points.reserve(j.tenantId,key(j),'copilot',bound,maxOutput,db);}
  catch(error){
   // Lost COMMIT acknowledgement / duplicate reservation: recover only this
   // existing key. Never reserve under a new UUID, never retry the model.
   const old=await call(j);
   if(old){check(old,estimate);if(old.status!=='reserved')throw Error('insights_meter_request_terminal');reserved=old.call_id;}
   else{await store.settleBudget(j,ticket.ticket,'not_called');
    if(error instanceof AiPointsError&&error.code==='ai_points_insufficient')return null;
    throw error;}
  }
  if(!await store.attachPoints(j,ticket.ticket,reserved!)){await settle(j,ticket.ticket,null,'not_called');return null;}
  return ticket;
 },finish:async(j:InsightJob,state:'saved'|'revoked'|'budget_exhausted'|'rejected'|'uncertain')=>{
  const b=await store.budgetState(j);
  if(b&&['held','calling','unknown'].includes(b.state)){
   const outcome=await settle(j,b.ticket,null,b.state==='held'?'not_called':'unknown');if(outcome==='unknown')state='uncertain';
  }
  await store.finish(j,state);
 }};
}
