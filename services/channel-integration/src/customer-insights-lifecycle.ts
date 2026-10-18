/** Default-off, single-flight bounded scheduling. Intake verification may retry
 * reads; generation jobs never retry a possibly consumed model request. stop
 * closes admission immediately and drains actual in-flight work before return. */
export function createCustomerInsightsLifecycle(ports:{enabled?:()=>boolean;intake():Promise<boolean>;generate():Promise<boolean>;
 recover():Promise<void>;discover?():Promise<number>;report?:(state:'processed'|'unavailable',count:number)=>void;schedule?:(callback:()=>void,ms:number)=>()=>void}){
 const enabled=ports.enabled??(()=>false);let stopped=false,started=false,active:Promise<number>|null=null,cancel:(()=>void)|undefined,recoverAt=0;
 const available=()=>!stopped&&enabled();
 const run=async()=>{let count=0;
  if(Date.now()>=recoverAt){await ports.recover();recoverAt=Date.now()+60000;}
  if(available()&&ports.discover)count+=await ports.discover();
  for(let i=0;i<4&&available();i++){if(!await ports.intake())break;count++;}
  if(available()&&await ports.generate())count++;
  return count;
 };
 const tick=()=>{
  if(!available()||active)return Promise.resolve(0);
  active=run();const p=active;void p.finally(()=>{if(active===p)active=null;}).catch(()=>{});return p;
 };
 const schedule=ports.schedule??((callback,ms)=>{const t=setTimeout(callback,ms);t.unref();return ()=>clearTimeout(t);});
 const report=(state:'processed'|'unavailable',n:number)=>{try{ports.report?.(state,n);}catch{/* diagnostics cannot break scheduling/drain */}};
 const loop=(delay=1000)=>{if(!available())return;cancel=schedule(()=>{cancel=undefined;void tick().then(n=>{if(n)report('processed',n);loop();},()=>{report('unavailable',0);loop(10000);}).catch(()=>{});},delay);};
 return {tick,available,start:()=>{if(stopped)throw Error('insights_lifecycle_stopped');if(!started){started=true;loop();}},
  stop:async()=>{stopped=true;cancel?.();cancel=undefined;await active?.catch(()=>report('unavailable',0));}};
}
