import {pool} from './database.js';
import {aiPointsEnabled,reserveAiPoints,settleAiPoints} from './ai-points.js';
import {qwenRuntimeConfig,qwenText} from './qwen-runtime.js';
import {lockKnowledgeCapacity} from './knowledge-capacity.js';
import {createHistoricalKnowledgeService} from './reception-history-knowledge.js';
import type {createAuthorizedReceptionHistoryReader} from './reception-history-reader.js';
import {withHistoryModelDeadline} from './reception-history-model-deadline.js';
import {EntitlementLimitError} from './subscriptions.js';
/** Composition only. No startup scheduling, tenant endpoint or enabling env.
 * Actual point reservation/settlement and normal knowledge capacity are reused.
 * One 25s deadline bounds the complete model operation, including stream reads. */
export function createLiveHistoryKnowledgeService(reader:ReturnType<typeof createAuthorizedReceptionHistoryReader>,options:{enabled?:()=>boolean;fetcher?:typeof fetch}={}){
 return createHistoricalKnowledgeService(pool,reader,{
  enabled:options.enabled??(()=>false),pointsEnabled:aiPointsEnabled,
  configured:()=>{try{qwenRuntimeConfig();return true;}catch{return false;}},
  reserve:(tenant,key,input,output)=>reserveAiPoints(tenant,key,'studio',input,output),settle:settleAiPoints,
  capacity:async(c,tenant,bytes)=>{try{await lockKnowledgeCapacity(c,tenant,bytes);}catch(e){if(e instanceof EntitlementLimitError)throw Error('history_capacity_exceeded');throw e;}},
  model:(messages,maxOutput,json)=>withHistoryModelDeadline(async signal=>{
   const fetcher:typeof fetch=(url,init)=>(options.fetcher??fetch)(url,{...init,
    signal:init?.signal?AbortSignal.any([init.signal,signal]):signal});
   return qwenText(messages,maxOutput,fetcher,json);
  })
 });
}
