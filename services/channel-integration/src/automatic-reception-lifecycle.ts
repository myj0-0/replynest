/** Default-off lifecycle shared by gateway registration and isolated acceptance.
 * Reports only fixed status and bounded batch size, never job/body/tenant/provider errors.
 */
export function startAutomaticReceptionLifecycle(queue:{tick:()=>Promise<number>;stop:()=>Promise<void>},options:{
 enabled?:()=>boolean;schedule?:(callback:()=>void,delay:number)=>()=>void;
 /** Server-owned, bounded polling interval; due replies use a separate loop. */
 intervalMs?:number;
 report?:(state:'processed'|'unavailable',count:number)=>void}={}){
 const enabled=options.enabled??(()=>false),report=options.report??(()=>{});
 const interval=options.intervalMs??3000;
 if(!Number.isInteger(interval)||interval<250||interval>3000)throw Error('invalid_automatic_poll_interval');
 const schedule=options.schedule??((callback,delay)=>{const timer=setTimeout(callback,delay);timer.unref();return ()=>clearTimeout(timer);});
 let stopping=false,cancel:(()=>void)|undefined,active:Promise<void>|undefined;
 const tick=()=>{
  if(stopping)return;
  let delay=interval;
  const run=Promise.resolve().then(async()=>{
   if(!enabled())return;
   const n=await queue.tick();if(n)report('processed',Math.min(10,n));
  }).catch(()=>{delay=10000;report('unavailable',0);}).finally(()=>{active=undefined;if(!stopping)cancel=schedule(tick,delay);});
  active=run;
 };
 cancel=schedule(tick,interval);
 return async()=>{stopping=true;cancel?.();const draining=queue.stop();await active;await draining;};
}
