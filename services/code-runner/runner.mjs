import {Worker} from 'node:worker_threads';
export async function execute(source,input){
 if(typeof source!=='string'||source.length>8000||!source.trim()||typeof input!=='string'||Buffer.byteLength(input)>32768)return {error:'code_input_limit'};
 return new Promise(resolve=>{
  const worker=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{source,input},env:{},resourceLimits:{maxOldGenerationSizeMb:48,maxYoungGenerationSizeMb:8,stackSizeMb:2},stdout:true,stderr:true});
  // Drain, never return runtime stdout/stderr or source to users/logging.
  worker.stdout.resume();worker.stderr.resume();let finished=false;
  const finish=async value=>{if(finished)return;finished=true;clearTimeout(timer);await worker.terminate();resolve(value);};
  const timer=setTimeout(()=>void finish({error:'code_timeout'}),2000);
  worker.once('message',value=>void finish(value));worker.once('error',()=>void finish({error:'code_resource_limit'}));worker.once('exit',()=>void finish({error:'code_execution_failed'}));
 });
}
