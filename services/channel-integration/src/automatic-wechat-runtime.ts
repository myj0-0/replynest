import type {Pool} from 'pg';
import {createAutomaticWeChatAdapter} from './automatic-wechat-adapter.js';
import {createAutomaticWeChatIntake} from './automatic-wechat-intake.js';
import {createAutomaticReceptionQueue} from './automatic-reception-queue.js';
import {startAutomaticReceptionLifecycle} from './automatic-reception-lifecycle.js';
import {createAutomaticReplyWaitRuntime,type AutomaticReplyWaitPresentation} from './automatic-reply-wait-runtime.js';

/** Server-only, explicitly started composition. No schema installation.
 * Credentials and metered generation must be trusted server ports.
 * One bounded intake precedes each worker batch; disabled means zero I/O/timers.
 */
export function createAutomaticWeChatRuntime(db:Pick<Pool,'query'|'connect'>,
 options:Parameters<typeof createAutomaticWeChatAdapter>[1]&{
  schedule?:NonNullable<Parameters<typeof startAutomaticReceptionLifecycle>[1]>['schedule'];
  report?:NonNullable<Parameters<typeof startAutomaticReceptionLifecycle>[1]>['report'];
  timing?:AutomaticReplyWaitPresentation;
 }){
 let stopped=false,stopWorker:(()=>Promise<void>)|undefined,stopWaiting:(()=>Promise<void>)|undefined,drain:Promise<void>|undefined,shutdown:Promise<void>|undefined;
 const enabled=()=>!stopped&&(options.enabled?.()??false);
 const adapter=createAutomaticWeChatAdapter(db,{...options,enabled});
 const waiting=options.timing?createAutomaticReplyWaitRuntime(db,{...options.timing,enabled,family:'wechat',adapter,question:l=>adapter.canonicalQuestion!(l)}):null;
 const intake=createAutomaticWeChatIntake(db,{enabled});
 const queue=createAutomaticReceptionQueue(db,{enabled,adapter,channelFamily:'wechat',...(waiting?{defer:waiting.defer}:{})});
 let active:Promise<number>|null=null;
 const batch={
  tick:()=>{
   if(active||!enabled())return Promise.resolve(0);
   const run=Promise.resolve().then(async()=>{
    await intake.tick();
    return enabled()?queue.tick():0;
   });
   active=run;void run.finally(()=>{if(active===run)active=null;}).catch(()=>{});return run;
  },
  stop:()=>{
   if(drain)return drain;
   stopped=true;
   drain=Promise.allSettled([intake.stop(),queue.stop(),active,stopWaiting?stopWaiting():waiting?.stop()]).then(results=>{
    if(results.some(r=>r.status==='rejected'))throw Error('automatic_wechat_stop_failed');
   });
   return drain;
  }
 };
 return {
  tick:batch.tick,
  tickWaiting:()=>waiting?.tick()??Promise.resolve(0),
  start:()=>{
   if(stopped)throw Error('automatic_wechat_stopping');
   if(enabled()&&!stopWorker)stopWorker=startAutomaticReceptionLifecycle(batch,{enabled,schedule:options.schedule,report:options.report});
   if(enabled()&&waiting&&!stopWaiting)stopWaiting=startAutomaticReceptionLifecycle(waiting,{enabled,schedule:options.schedule,report:options.report,intervalMs:500});
  },
  stop:()=>{
   if(!shutdown)shutdown=Promise.allSettled([stopWorker?.(),batch.stop()]).then(results=>{
    if(results.some(r=>r.status==='rejected'))throw Error('automatic_wechat_stop_failed');
   });
   return shutdown;
  }
 };
}
