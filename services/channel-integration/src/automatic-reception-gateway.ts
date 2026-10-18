import type {Pool} from 'pg';
import type {AutomaticInbound} from './automatic-reception-queue.js';
import type {ReceptionDraft} from './reception-executor.js';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import type {AutomaticReceptionConfig} from './automatic-reception-config.js';
import {createAutomaticManagementApi} from './automatic-reception-management-api.js';
import {createAutomaticReceptionHttp} from './automatic-reception-http.js';
import {createAutomaticWebProjection,createAutomaticProjectionReader} from './automatic-web-projection.js';
import {createAutomaticNativeClient} from './automatic-web-native-client.js';
import {createAutomaticWebChatAdapter} from './automatic-web-chat.js';
import {createAutomaticWebIngress,createAutomaticReceptionQueue} from './automatic-reception-queue.js';
import {startAutomaticReceptionLifecycle} from './automatic-reception-lifecycle.js';
import {createAutomaticWeChatRuntime} from './automatic-wechat-runtime.js';
import {createAutomaticWeChatTokenResolver} from './automatic-wechat-credentials.js';
import {createAutomaticWeChatHistoryWorker} from './automatic-wechat-history-worker.js';
import type {AutomaticSenderPort} from './automatic-sender.js';
import {createAutomaticReplyWaitRuntime,type AutomaticReplyWaitPresentation} from './automatic-reply-wait-runtime.js';

/** Actual gateway composition, shared with isolated acceptance. The ports below
 * are trusted SERVER dependencies, never values in a tenant request/model output. */
export function createAutomaticGatewayRuntime(db:Pick<Pool,'query'|'connect'>,config:AutomaticReceptionConfig,ports:{
 generate:(l:AutomaticReceptionLease,question:string)=>Promise<ReceptionDraft>;
 draft:(payload:unknown)=>Promise<void>;fetcher?:typeof fetch;
 workflow?:(event:AutomaticInbound)=>Promise<void>;
 insights?:{enabled:()=>boolean;bridgeSecret:string;admit:(event:AutomaticInbound)=>Promise<'queued'|'ignored'|'backpressure'>};
 report?:(state:'processed'|'unavailable',count:number)=>void;
 schedule?:(callback:()=>void,delay:number)=>()=>void;
 timing?:AutomaticReplyWaitPresentation;
 wechat?:{
  native?:Parameters<typeof createAutomaticWeChatRuntime>[1]['native'];
  history?:Parameters<typeof createAutomaticWeChatHistoryWorker>[1]['native'];
  credentials?:Omit<NonNullable<Parameters<typeof createAutomaticWeChatTokenResolver>[1]>,'enabled'|'fetcher'>;
 };
}){
 if(config.timing&&(!(config.web||config.wechat)||!ports.timing))throw Error('automatic_reply_timing_ports_required');
 if(config.bridgeSecret&&ports.insights&&config.bridgeSecret!==ports.insights.bridgeSecret)throw Error('customer_insights_bridge_mismatch');
 let stopped=false;const web=()=>!stopped&&config.web,wechatEnabled=()=>!stopped&&config.wechat,historyEnabled=()=>!stopped&&config.wechatHistory;
 // Preparing a signed, account-scoped identity must not start an executor or
 // depend on enabling old send grants. Readiness still is NOT tenant consent.
 const native=config.senderManagement||config.web||config.wechat?createAutomaticNativeClient({origin:config.origin,secret:config.nativeSecret,fetcher:ports.fetcher}):null;
 const sender:AutomaticSenderPort={
  inspect:async accountId=>{if(stopped||!native)return 'platform_disabled';const state=await native.sender.inspect(accountId);return stopped?'platform_disabled':state;},
  prepare:async accountId=>{if(stopped||!native)return 'platform_disabled';const state=await native.sender.prepare(accountId);return stopped?'platform_disabled':state;}
 };
 const management=createAutomaticManagementApi(db,{enabled:()=>!stopped&&config.management,
  wechatEnabled:()=>!stopped&&config.wechatManagement,requireWorkspaceHeader:true,sender});
 const project=config.web?createAutomaticWebProjection(db,{enabled:web,read:createAutomaticProjectionReader({origin:config.origin,token:config.token,fetcher:ports.fetcher})}):async()=> 'ignored' as const;
 const ingress=config.web?createAutomaticWebIngress(db,{enabled:web,secret:config.bridgeSecret,snapshot:native!.snapshot}):async()=> 'disabled' as const;
 const callback=createAutomaticReceptionHttp({enabled:()=>!stopped&&config.callback,closedAck:config.closedCallbackAck,secret:config.bridgeSecret||ports.insights?.bridgeSecret||'',project,ingress,
  insightsEnabled:()=>!stopped&&!!ports.insights?.enabled(),insights:ports.insights?.admit,
  workflow:ports.workflow,draft:config.draftCallback?ports.draft:undefined});
 const adapter=config.web?createAutomaticWebChatAdapter(db,{enabled:web,origin:config.origin,secret:config.nativeSecret,fetcher:ports.fetcher,generate:ports.generate,
  policy:async()=>({executorAvailable:web(),generateEnabled:true,sendEnabled:true,consentVersion:'automatic-reply-v1',sendConsentVersion:'automatic-send-v1',
   pointsAvailable:true,thresholdPercent:95,requiresHumanApproval:false})}):null;
 // Actual balance reservation is mandatory in the metered generator. The 95%
 // threshold is the server-approved exact-answer gate, not a model self-score.
 const waiting=config.timing&&adapter?createAutomaticReplyWaitRuntime(db,{...ports.timing!,enabled:web,family:'web',adapter,
  question:l=>adapter.canonicalQuestion!(l)}):null;
 const queue=adapter?createAutomaticReceptionQueue(db,{enabled:web,adapter,...(waiting?{defer:waiting.defer}:{})}):null;
 const wechat=config.wechat?createAutomaticWeChatRuntime(db,{enabled:wechatEnabled,origin:config.origin,secret:config.nativeSecret,
  native:ports.wechat?.native,fetcher:ports.fetcher,generate:ports.generate,
  resolveAccessToken:createAutomaticWeChatTokenResolver(db,{...ports.wechat?.credentials,enabled:wechatEnabled,fetcher:ports.fetcher}),
  report:ports.report,schedule:ports.schedule,...(config.timing?{timing:ports.timing!}:{})}):null;
 const history=config.wechatHistory?createAutomaticWeChatHistoryWorker(db,{origin:config.origin,secret:config.nativeSecret,
  enabled:historyEnabled,fetcher:ports.fetcher,native:ports.wechat?.history}):null;
 let stopWorker:(()=>Promise<void>)|undefined,stopWaiting:(()=>Promise<void>)|undefined,stopHistory:(()=>Promise<void>)|undefined,drain:Promise<void>|undefined;
 return {
  management,sender,callback:callback.handle,
  /** Internal acceptance/maintenance seams, not exposed as tenant HTTP actions. */
  tick:()=>queue?.tick()??Promise.resolve(0),
  tickWaiting:()=>waiting?.tick()??Promise.resolve(0),
  start:()=>{if(stopped)throw Error('automatic_reception_stopping');if(queue&&!stopWorker)stopWorker=startAutomaticReceptionLifecycle(queue,{enabled:web,report:ports.report,schedule:ports.schedule});wechat?.start();
   if(waiting&&!stopWaiting)stopWaiting=startAutomaticReceptionLifecycle(waiting,{enabled:web,report:ports.report,schedule:ports.schedule,intervalMs:500});
   if(history&&!stopHistory)stopHistory=startAutomaticReceptionLifecycle(history,{enabled:historyEnabled,report:ports.report,schedule:ports.schedule});},
  stop:()=>{if(drain)return drain;stopped=true;const callbacks=callback.stop(),worker=stopWorker?stopWorker():queue?.stop();
   drain=Promise.allSettled([callbacks,worker,stopWaiting?stopWaiting():waiting?.stop(),wechat?.stop(),stopHistory?stopHistory():history?.stop()]).then(r=>{if(r.some(v=>v.status==='rejected'))throw Error('automatic_reception_stop_failed');});return drain;}
 };
}
