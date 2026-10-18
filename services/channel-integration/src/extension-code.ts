import {pool} from './database.js';
import {ExtensionError,runExtension,validateDefinition,type ExtensionDefinition} from './extension-core.js';
import {secretValue} from './secret-value.js';
export const codePolicy={engine:'quickjs-wasm-v1',execution_ms:500,wall_ms:2000,memory_bytes:16*1024*1024,source_chars:8000,input_bytes:32768,output_bytes:32768,tenant_runs_per_minute:30};
export const codeEnabled=()=>process.env.EXTENSION_CODE_ENABLED==='true';
let pendingRuns=0;
export async function invokeCode(source:string,input:unknown,fetcher:typeof fetch=fetch){
  if(!codeEnabled())throw new ExtensionError('code_disabled',503);
 const url=process.env.EXTENSION_RUNNER_URL,token=secretValue('EXTENSION_RUNNER_TOKEN');
 if(!url||!token)throw new ExtensionError('code_unavailable',503);
 const json=JSON.stringify(input);if(Buffer.byteLength(json)>codePolicy.input_bytes)throw new ExtensionError('code_input_limit');
 let response:Response;try{response=await fetcher(url+'/execute',{method:'POST',redirect:'error',signal:AbortSignal.timeout(3000),headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({source,input:json})});}catch{throw new ExtensionError('code_unavailable',503);}
 if(response.status===429)throw new ExtensionError('code_runner_busy',429);
 if(!response.ok)throw new ExtensionError('code_unavailable',503);
 const reader=response.body?.getReader();if(!reader)throw new ExtensionError('code_unavailable',503);
 let length=0;const chunks:Uint8Array[]=[];
 try{for(;;){const r=await reader.read();if(r.done)break;length+=r.value.length;if(length>200000){await reader.cancel();throw new Error();}chunks.push(r.value);}}catch{throw new ExtensionError('code_output_limit');}
 let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ExtensionError('code_unavailable',503);}
 if(result.error){const codes=['code_timeout','code_execution_failed','code_resource_limit','code_output_limit','code_input_limit'];throw new ExtensionError(codes.includes(result.error)?result.error:'code_execution_failed',422);}
 if(typeof result.json!=='string'||Buffer.byteLength(result.json)>codePolicy.output_bytes)throw new ExtensionError('code_output_limit');
 try{return JSON.parse(result.json);}catch{throw new ExtensionError('code_invalid_output',422);}
}
export function validateCodeOutput(definition:ExtensionDefinition,value:unknown){
 // No unknown fields, HTML execution, tenant identifiers or type/length bypass through results.
 try{return runExtension({...definition,code:undefined,workflow:{trigger:'form.submitted',rules:[]}},value).data;}catch{throw new ExtensionError('code_invalid_output',422);}
}
export async function runExtensionWithCode(raw:unknown,input:unknown,context:{tenant:string;app:string;version:number;actor:string}){
 const definition=validateDefinition(raw),base=runExtension(definition,input);
 if(!definition.code)return base;
 if(!codeEnabled())throw new ExtensionError('code_disabled',503);
 if(pendingRuns>=2)throw new ExtensionError('code_runner_busy',429);
 pendingRuns++;
 try{
 // Separate committed reservations count failures too. No source, input or output stored in diagnostics.
 const c=await pool.connect();let id:string;
 try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['extension-code:'+context.tenant]);
  const count=(await c.query("SELECT count(*)::int n FROM tenant_extension_code_runs WHERE tenant_id=$1 AND created_at>NOW()-INTERVAL '1 minute'",[context.tenant])).rows[0].n;
  if(count>=30)throw new ExtensionError('code_rate_limited',429);
  id=(await c.query("INSERT INTO tenant_extension_code_runs(tenant_id,extension_id,version,actor_id,status) VALUES($1,$2,$3,$4,'running') RETURNING run_id",[context.tenant,context.app,context.version,context.actor])).rows[0].run_id;
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 const started=Date.now();
 try{
  const data=validateCodeOutput(definition,await invokeCode(definition.code.source,base.data));
  await pool.query("UPDATE tenant_extension_code_runs SET status='succeeded',duration_ms=$2,completed_at=NOW() WHERE run_id=$1",[id,Date.now()-started]);
  return {...base,data,code_execution:{run_id:id,duration_ms:Date.now()-started,engine:codePolicy.engine}};
 }catch(e){await pool.query("UPDATE tenant_extension_code_runs SET status='failed',error_code=$2,duration_ms=$3,completed_at=NOW() WHERE run_id=$1",[id,e instanceof ExtensionError?e.code:'code_execution_failed',Date.now()-started]);throw e;}
 }finally{pendingRuns--;}
}
