// One outstanding invocation per loop. Yield after busy batches, back off on
// empty queues or failure. Timers do not keep a shutting-down process alive.
export function startBoundedPoll(work:()=>Promise<{retrySoon:boolean}|void>,onError:()=>void){
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
 const tick=async()=>{
  let delay=1000;
  try{if((await work())?.retrySoon)delay=25;}catch{delay=5000;onError();}
  if(!stopped){timer=setTimeout(()=>{void tick();},delay);timer.unref();}
 };
 void tick();
 return ()=>{stopped=true;if(timer)clearTimeout(timer);};
}
