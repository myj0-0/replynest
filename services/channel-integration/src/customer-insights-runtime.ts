import type {Pool} from 'pg';
import {createCustomerInsightsStore} from './customer-insights-store.js';
import {createCustomerInsightsReader} from './customer-insights-reader.js';
import {createCustomerInsightsHistoryClient} from './reception-history-native-client.js';
import {createCustomerInsightsMeter} from './customer-insights-meter.js';
import {createCustomerInsightsWorker,type InsightsPorts,type InsightFailure} from './customer-insights-worker.js';
import {aiPointsEnabled} from './ai-points.js';
import {qwenRuntimeConfig,qwenText} from './qwen-runtime.js';
import {createCustomerInsightsIntakeStore,createCustomerInsightsIntakeWorker} from './customer-insights-intake.js';
import {createCustomerInsightsLifecycle} from './customer-insights-lifecycle.js';
import {createCustomerInsightsProjectionReader} from './customer-insights-projection-reader.js';
import {createCustomerInsightsSources} from './customer-insights-sources.js';

/** Composition remains default-off until owner schema/bridge/console deployment
 * and verification. Test seams are server-owned, never tenant-selected URLs. */
export function createCustomerInsightsRuntime(db:Pick<Pool,'connect'|'query'>,options:{enabled?:()=>boolean;
 native:Parameters<typeof createCustomerInsightsReader>[1];model:InsightsPorts['model'];points?:Parameters<typeof createCustomerInsightsMeter>[2];
 sharedEnabled?:()=>boolean;readConversation?:Parameters<typeof createCustomerInsightsIntakeWorker>[2]['readConversation'];
 schedule?:Parameters<typeof createCustomerInsightsLifecycle>[0]['schedule'];report?:Parameters<typeof createCustomerInsightsLifecycle>[0]['report'];reportFailure?:(failure:InsightFailure)=>void}){
 let stopped=false;const enabled=()=>!stopped&&!!options.enabled?.(),store=createCustomerInsightsStore(db),reader=createCustomerInsightsReader(store,options.native,enabled),meter=createCustomerInsightsMeter(db,store,options.points);
 const worker=createCustomerInsightsWorker({enabled,claim:store.claim,authorized:store.authorized,read:reader.read,skipBatch:store.skipBatch,
  reserve:meter.reserve,beginModel:store.beginModel,model:options.model,settle:meter.settle,save:store.save,finish:meter.finish,reportFailure:options.reportFailure});
 const intake=createCustomerInsightsIntakeStore(db,{enabled,sharedEnabled:options.sharedEnabled}),verifier=createCustomerInsightsIntakeWorker(intake,store,{enabled,native:options.native,readConversation:options.readConversation});
 const sources=createCustomerInsightsSources(db,intake,{enabled,sharedEnabled:options.sharedEnabled});
 const lifecycle=createCustomerInsightsLifecycle({enabled,discover:sources.pump,intake:verifier.runOne,generate:worker.runOne,schedule:options.schedule,report:options.report,recover:async()=>{
  if(!enabled())return;await sources.recover();await intake.recover();
  const tenants=(await db.query(`SELECT tenant_id FROM customer_insight_jobs WHERE state IN('leased','calling') AND lease_until<clock_timestamp()
   ORDER BY lease_until,tenant_id LIMIT 20`)).rows;
  for(const tenant of new Set(tenants.map(r=>String(r.tenant_id)))){if(!enabled())break;await store.recoverStale(tenant);}
 }});
 return {store,worker,intake,verifier,sources,tick:lifecycle.tick,start:lifecycle.start,stop:async()=>{stopped=true;await Promise.all([sources.stop(),lifecycle.stop()]);}};
}
export function createLiveCustomerInsightsRuntime(db:Pick<Pool,'connect'|'query'>,options:{origin:string;secret:string;token:string;enabled?:()=>boolean;sharedEnabled?:()=>boolean;fetcher?:typeof fetch;
 report?:Parameters<typeof createCustomerInsightsLifecycle>[0]['report']}){
 const enabled=()=>{if(!options.enabled?.()||!aiPointsEnabled())return false;try{qwenRuntimeConfig();return true;}catch{return false;}},fetcher=options.fetcher??fetch;
 const native=createCustomerInsightsHistoryClient({origin:options.origin,secret:options.secret,enabled,fetcher});
 const model:InsightsPorts['model']=async(messages,maxOutput,format)=>{if(!enabled())throw Error('insights_runtime_disabled');qwenRuntimeConfig();return qwenText(messages,maxOutput,fetcher,true,format);};
 return createCustomerInsightsRuntime(db,{enabled,native,model,sharedEnabled:options.sharedEnabled,report:options.report,
  readConversation:createCustomerInsightsProjectionReader({origin:options.origin,token:options.token,enabled,fetcher}),
  reportFailure:failure=>console.warn(JSON.stringify({event:'customer_insights_failure',phase:failure.phase,code:failure.code}))});
}
