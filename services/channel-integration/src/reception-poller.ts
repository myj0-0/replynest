type Tasks = {
  event:()=>Promise<boolean>; draft:()=>Promise<unknown>;
  discover:()=>Promise<unknown>; metrics:()=>Promise<unknown>;
};
type Kind=keyof Tasks;
/** Shared by the gateway and isolated acceptance. No test-only environment switches. */
export function startReceptionPoller(tasks:Tasks, options?:{
  enabled?:()=>boolean;
  schedule?:(tick:()=>void,ms:number)=>()=>void;
  report?:(kind:Kind,error:boolean,result?:unknown)=>void;
}) {
  const enabled=options?.enabled??(()=>process.env.AI_RECEPTION_DRAFT_WORKER_ENABLED==='true');
  const schedule=options?.schedule??((tick,ms)=>{const timer=setInterval(tick,ms);timer.unref();return ()=>clearInterval(timer);});
  const report=options?.report??((kind,error,result)=>{
    if(error)console.warn(`Reception ${kind} worker unavailable`);
    else if(kind==='metrics')console.info(JSON.stringify({event:'reception_event_backlog',...result as object}));
  });
  let stopped=false;
  const active=new Set<Promise<void>>();
  const busy=new Set<Kind>();
  const tick=(kind:Kind)=>{
    if(stopped||!enabled()||busy.has(kind))return;
    busy.add(kind);
    const run=Promise.resolve().then(async()=>{
      if(kind==='event'){
        for(let i=0;i<10&&!stopped&&enabled();i++)if(!await tasks.event())break;
      }else if(!stopped&&enabled())report(kind,false,await tasks[kind]());
    }).catch(()=>report(kind,true)).finally(()=>{busy.delete(kind);active.delete(run);});
    active.add(run);
  };
  const cancel=([['event',1000],['draft',3000],['discover',3000],['metrics',60000]] as const)
    .map(([kind,ms])=>schedule(()=>tick(kind),ms));
  // Stop new work and drain in-flight calls. It does not interrupt an HTTP/model request.
  return async()=>{stopped=true;cancel.forEach(stop=>stop());await Promise.allSettled([...active]);};
}
