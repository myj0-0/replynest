import {pool} from './database.js';
import {aiPointsEnabled,reserveAiPoints,settleAiPoints} from './ai-points.js';
import {qwenRuntimeConfig,qwenText} from './qwen-runtime.js';
import {createMeteredAutomaticGenerator} from './automatic-reception-generation.js';
import {createLiveAutomaticSemanticRetriever} from './automatic-knowledge-semantic-live.js';
import {createMeteredAutomaticSemanticVerifier} from './automatic-knowledge-verification.js';
import type {AutomaticGenerationPresentationPorts} from './automatic-reception-generation.js';

/** Explicit, default-off gateway composition; balance reservation remains mandatory.
 * fetcher is a trusted test seam, never a tenant-selected base URL or destination.
 */
export function createLiveAutomaticGenerator(options:{enabled?:()=>boolean;fetcher?:typeof fetch;semanticEnabled?:()=>boolean;
 presentation?:AutomaticGenerationPresentationPorts}={}){
 // Three bounded sequential requests must fit the two-minute task lease.
 // Server-owned transport only; never accept tenant destinations or retries.
 const fetcher:typeof fetch=(url,init)=> (options.fetcher??fetch)(url,{...init,
  signal:init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000)});
 const ports={
  enabled:options.enabled??(()=>false),pointsEnabled:aiPointsEnabled,
  configured:()=>{try{qwenRuntimeConfig();return true;}catch{return false;}},
  reserve:(tenant:string,key:string,input:number,output:number)=>reserveAiPoints(tenant,key,'copilot',input,output),
  settle:settleAiPoints,model:(messages:{role:'system'|'user';content:string}[],maxTokens:number,json=false)=>qwenText(messages,maxTokens,fetcher,json)
 };
 const semanticEnabled=()=>ports.enabled()&&(options.semanticEnabled?.()??process.env.AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED==='true');
 const retrieve=createLiveAutomaticSemanticRetriever({enabled:semanticEnabled,fetcher});
 const verify=createMeteredAutomaticSemanticVerifier(pool,{...ports,enabled:semanticEnabled});
 return createMeteredAutomaticGenerator(pool,ports,{enabled:semanticEnabled,retrieve,verify},options.presentation);
}
