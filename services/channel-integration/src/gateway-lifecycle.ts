/** Own timers/work started by the gateway, without silently cancelling an external
 * request. Stop prevents new starts, cancels every registered scheduler and drains
 * the work already observed; an outer process timeout remains a crash/uncertain case. */
export function createGatewayLifecycle(){
 let stopping=false,drain:Promise<void>|undefined;
 const active=new Set<Promise<unknown>>(),stops:Array<()=>void|Promise<void>>=[];
 const run=<T>(work:()=>Promise<T>|T):Promise<T>=>{
  if(stopping)return Promise.reject(Error('gateway_stopping'));
  const p=Promise.resolve().then(()=>{if(stopping)throw Error('gateway_stopping');return work();});active.add(p);
  void p.finally(()=>active.delete(p)).catch(()=>{});return p;
 };
 const register=(stop:()=>void|Promise<void>)=>{if(stopping)throw Error('gateway_stopping');stops.push(stop);};
 return {
  get stopping(){return stopping;},run,register,
  every:(work:()=>Promise<unknown>|unknown,ms:number,onError:()=>void=()=>{})=>{
   if(stopping||!Number.isFinite(ms)||ms<=0)throw Error('invalid_gateway_interval');
   const timer=setInterval(()=>{void run(work).catch(()=>{if(!stopping)onError();});},ms);timer.unref();register(()=>clearInterval(timer));
  },
  stop:()=>{
   if(drain)return drain;stopping=true;
   // Start ALL cancellations synchronously before waiting for any slow worker.
   const cancelled=stops.map(stop=>{try{return Promise.resolve(stop());}catch{return Promise.reject(Error('gateway_stop_failed'));}});
   drain=Promise.allSettled([...cancelled,...active]).then(results=>{if(results.slice(0,cancelled.length).some(r=>r.status==='rejected'))throw Error('gateway_stop_failed');});
   return drain;
  }
 };
}
