import {pool} from './database.js';
import {aiPointsEnabled,reserveAiPoints,settleAiPoints} from './ai-points.js';
import {qwenRuntimeConfig,qwenEmbedding} from './qwen-runtime.js';
import {createMeteredAutomaticSemanticRetriever} from './automatic-knowledge-semantic-store.js';

/** Staged, default-off trusted composition. Not registered in the gateway/send
 * executor yet; v3 administrator disclosure and a frozen release are required. */
export function createLiveAutomaticSemanticRetriever(options:{enabled?:()=>boolean;fetcher?:typeof fetch}={}){
 return createMeteredAutomaticSemanticRetriever(pool,{
  enabled:options.enabled??(()=>false),pointsEnabled:aiPointsEnabled,
  configured:()=>{try{qwenRuntimeConfig();return true;}catch{return false;}},
  reserve:(tenant,key,input)=>reserveAiPoints(tenant,key,'embedding_query',input,0),settle:settleAiPoints,
  embed:question=>qwenEmbedding(question,options.fetcher)
 });
}
