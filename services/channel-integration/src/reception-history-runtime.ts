/** Default-off history runtime. SQL owns tenant/purpose consent and job leases;
 * this scheduler owns bounded starts, no overlapping work, and shutdown drain.
 * No provider retry, recovery/reaper, transcript log or customer sending here. */
export type ReceptionHistoryConfig=Readonly<{read:boolean;knowledge:boolean;style:boolean;origin:string;secret:string}>;
export function validateReceptionHistoryStartup(env:NodeJS.ProcessEnv,secret:(name:string)=>string|undefined,modelConfigured:()=>void):ReceptionHistoryConfig{
 const flag=(name:string)=>{const v=env[name];if(v===undefined||v===''||v==='false')return false;if(v==='true')return true;throw Error('reception_history_flag_invalid');};
 const read=flag('AI_RECEPTION_HISTORY_READ_ENABLED'),knowledge=flag('AI_HISTORY_KNOWLEDGE_GENERATION_ENABLED'),style=flag('AI_RECEPTION_STYLE_LEARNING_ENABLED');
 if((knowledge||style)&&!read)throw Error('reception_history_read_required');
 if(!read)return Object.freeze({read,knowledge,style,origin:'',secret:''});
 if(env.AI_RECEPTION_PERSONALIZATION_MANAGEMENT_ENABLED!=='true'||env.AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED!=='true'||env.DATABASE_STARTUP_MODE!=='verify')
  throw Error('reception_history_verified_management_required');
 if(knowledge&&(env.AI_HISTORY_KNOWLEDGE_DRAFTS_ENABLED!=='true'||env.AI_POINTS_ENABLED!=='true'))throw Error('reception_history_knowledge_dependencies_required');
 try{
  const key=secret('REPLYNEST_AUTOMATIC_REPLY_SECRET'),origin=new URL(env.CHATWOOT_BASE_URL??'');
  if(!key||Buffer.byteLength(key)<32||Buffer.byteLength(key)>65536||/[\0\r\n]/.test(key)||
   !['http:','https:'].includes(origin.protocol)||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash)throw Error();
  if(knowledge)modelConfigured();
  return Object.freeze({read,knowledge,style,origin:origin.origin,secret:key});
 }catch{throw Error('reception_history_configuration_invalid');}
}

/** Tone/context can feed verified generation. Timing stays unavailable until
 * persisted due-queue integration; these flags never authorize customer sends. */
export function validateReceptionDraftPresentationStartup(env:NodeJS.ProcessEnv):Readonly<{draft:boolean;context:boolean;automatic:boolean}>{
 const flag=(name:string)=>{const v=env[name];if(v===undefined||v===''||v==='false')return false;if(v==='true')return true;throw Error('reception_presentation_flag_invalid');};
 const draft=flag('AI_RECEPTION_DRAFT_PRESENTATION_ENABLED'),context=flag('AI_RECEPTION_HISTORY_CONTEXT_ENABLED'),automatic=flag('AI_RECEPTION_AUTOMATIC_PRESENTATION_ENABLED');
 if(context&&(!(draft||automatic)||env.AI_RECEPTION_HISTORY_READ_ENABLED!=='true'))throw Error('reception_context_dependencies_required');
 if((draft||automatic)&&(env.AI_RECEPTION_PERSONALIZATION_MANAGEMENT_ENABLED!=='true'||env.AI_RECEPTION_AUTOMATIC_MANAGEMENT_ENABLED!=='true'||env.DATABASE_STARTUP_MODE!=='verify'))
  throw Error('reception_presentation_verified_management_required');
 if(automatic&&(env.AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED!=='true'||env.AI_POINTS_ENABLED!=='true'))throw Error('reception_automatic_presentation_verifier_required');
 return Object.freeze({draft,context,automatic});
}
type JobResult={state:'disabled'|'idle'|'succeeded'|'failed'|'uncertain'};
type StyleResult={state:'disabled'|'processed';scanned:number;nextTenant:string|null};
type Schedule=(callback:()=>void,delay:number)=>()=>void;
export function createReceptionHistoryQueueRuntime(ports:{knowledge?:{runOne:()=>Promise<JobResult>};
 style?:{batch:(input:{afterTenant?:string;limit:5})=>Promise<StyleResult>};
 enabled?:()=>boolean;schedule?:Schedule;report?:(worker:'knowledge'|'style',state:'processed'|'unavailable',count:number)=>void}){
 const enabled=ports.enabled??(()=>false),report=ports.report??(()=>{});
 const schedule=ports.schedule??((callback,delay)=>{const timer=setTimeout(callback,delay);timer.unref();return ()=>clearTimeout(timer);});
 let stopped=false,started=false,drain:Promise<void>|undefined;
 const active=new Set<Promise<void>>(),cancellations=new Map<string,()=>void>();
 const startLoop=(worker:'knowledge'|'style',interval:number,work:()=>Promise<number>)=>{
  let running=false;
  const tick=()=>{
   if(stopped||running)return;cancellations.delete(worker);running=true;
   let delay=interval;
   const p=Promise.resolve().then(async()=>{
    if(stopped||!enabled())return;
    const n=await work();if(!Number.isInteger(n)||n<0||n>5)throw Error('invalid_history_batch');
    if(n)report(worker,'processed',n);
   }).catch(()=>{delay=Math.max(interval,10000);if(!stopped)report(worker,'unavailable',0);}).finally(()=>{
    running=false;active.delete(p);if(!stopped)cancellations.set(worker,schedule(tick,delay));
   });active.add(p);void p.catch(()=>{});
  };
  cancellations.set(worker,schedule(tick,interval));
 };
 return {start:()=>{
  if(stopped)throw Error('reception_history_stopping');if(started)return;started=true;if(!enabled())return;
  if(ports.knowledge)startLoop('knowledge',3000,async()=>{const r=await ports.knowledge!.runOne();
   if(!['disabled','idle','succeeded','failed','uncertain'].includes(r.state))throw Error('invalid_history_result');
   return ['disabled','idle'].includes(r.state)?0:1;});
  if(ports.style){let afterTenant:string|undefined;
   startLoop('style',30000,async()=>{const r=await ports.style!.batch({...(afterTenant?{afterTenant}:{}),limit:5});
    if(!['disabled','processed'].includes(r.state)||!Number.isInteger(r.scanned)||r.scanned<0||r.scanned>5||
     r.nextTenant!==null&&(typeof r.nextTenant!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(r.nextTenant)||afterTenant!==undefined&&r.nextTenant<=afterTenant)||
     r.state==='disabled'&&(r.scanned!==0||r.nextTenant!==null)||r.scanned===0&&r.nextTenant!==null||r.scanned>0&&r.nextTenant===null)throw Error('invalid_history_style_batch');
    afterTenant=r.nextTenant??undefined;return r.scanned;});}
 },stop:()=>{
  if(drain)return drain;stopped=true;let cancelFailed=false;
  for(const cancel of cancellations.values()){try{cancel();}catch{cancelFailed=true;}}cancellations.clear();
  drain=Promise.allSettled([...active]).then(()=>{if(cancelFailed)throw Error('reception_history_stop_failed');});return drain;
 }};
}
