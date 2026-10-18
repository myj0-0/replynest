import {qwenText,qwenEmbedding,QwenError} from './qwen-runtime.js';
type Probe={status:'operational'|'degraded'|'major_outage';checked_at:string|null;latency_ms:number;reason:string};
const cache:Record<string,Probe>={text:{status:'degraded',checked_at:null,latency_ms:0,reason:'not_checked'},embedding:{status:'degraded',checked_at:null,latency_ms:0,reason:'not_checked'}};
let running=false;
export function aiModelHealth(kind:string){const result=cache[kind];if(!result)return null;
 if(process.env.AI_MODEL_MONITOR_ENABLED!=='true')return {...result,status:'degraded',reason:'monitor_disabled'};
 if(!result.checked_at||Date.now()-Date.parse(result.checked_at)>10*60_000)return {...result,status:'degraded',reason:'probe_stale'};
 return result;
}
export async function probeAiModels(){
 if(running||process.env.AI_MODEL_MONITOR_ENABLED!=='true')return;running=true;
 try{await Promise.all(['text','embedding'].map(async kind=>{const start=performance.now();try{
  if(kind==='text')await qwenText([{role:'user',content:'Reply OK.'}],4);else await qwenEmbedding('ReplyNest health check.');
  cache[kind]={status:'operational',checked_at:new Date().toISOString(),latency_ms:Math.round(performance.now()-start),reason:'probe_succeeded'};
 }catch(e){cache[kind]={status:e instanceof QwenError&&e.code==='qwen_rate_limited'?'degraded':'major_outage',checked_at:new Date().toISOString(),latency_ms:Math.round(performance.now()-start),reason:e instanceof QwenError?e.code:'probe_failed'};}}));}finally{running=false;}
}
export function startAiModelMonitor(){
 const active=new Set<Promise<void>>();let stopped=false;
 const run=()=>{if(stopped)return;const p=probeAiModels();active.add(p);void p.finally(()=>active.delete(p)).catch(()=>{});};
 run();const timer=setInterval(run,5*60_000);timer.unref();
 return async()=>{stopped=true;clearInterval(timer);await Promise.allSettled([...active]);};
}
