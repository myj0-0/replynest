import {createHmac,randomBytes} from 'node:crypto';
import {requiredEnv} from './shared.js';
import {secretValue} from './secret-value.js';
export type AssignmentSnapshot={account_id:string;conversation_id:string;assignee_id:string|null;bot_id:string|null;status:string;updated_at:string};
export type AssignmentCommand={command_id:string;account_id:string;conversation_id:string;target_user_id:string;snapshot:AssignmentSnapshot};
export type AssignmentResult={command_id:string;state:'applied'|'state_changed'|'rejected'|'command_conflict'};
export const assignmentEnabled=()=>process.env.AUTOMATION_ASSIGNMENT_ENABLED==='true';
export function assignmentSecret():string {
 try {
  const value=secretValue('REPLYNEST_ASSIGNMENT_SECRET')??'';
  if(Buffer.byteLength(value)<32||Buffer.byteLength(value)>65536||value.includes('\0'))throw Error();
  return value;
 }catch{throw Error('atomic_assignment_not_configured');}
}
export function validateAssignmentStartup(){if(assignmentEnabled())assignmentSecret();}
export function validSnapshot(v:unknown):v is AssignmentSnapshot {
 if(!v||typeof v!=='object')return false;const x=v as AssignmentSnapshot;
 return /^\d+$/.test(x.account_id)&&/^\d+$/.test(x.conversation_id)&&[x.assignee_id,x.bot_id].every(i=>i===null||typeof i==='string'&&/^\d+$/.test(i))&&['open','pending','resolved','snoozed'].includes(x.status)&&typeof x.updated_at==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(x.updated_at);
}
export function createAtomicAssignment(config:{baseUrl:string;secret:string},fetcher:typeof fetch=fetch){
 async function post(action:string,body:unknown){
  if(Buffer.byteLength(config.secret)<32||Buffer.byteLength(config.secret)>65536||config.secret.includes('\0'))throw Error('atomic_assignment_not_configured');
  const path=`/internal/saas_sso/assignments/${action}`,raw=JSON.stringify(body),ts=String(Date.now()),nonce=randomBytes(16).toString('hex');
  const signature=createHmac('sha256',config.secret).update(`${path}\n${ts}\n${nonce}\n${raw}`).digest('hex');
  const r=await fetcher(config.baseUrl.replace(/\/$/,'')+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json','x-forwarded-proto':'https','x-assignment-timestamp':ts,'x-assignment-nonce':nonce,'x-assignment-signature':signature},body:raw});
  if(!r.ok){await r.body?.cancel();throw Error('atomic_assignment_unavailable');}const text=await r.text();if(text.length>8000)throw Error('atomic_assignment_invalid_response');return JSON.parse(text);
 }
 function result(v:AssignmentResult,id:string){if(v.command_id!==id||!['applied','state_changed','rejected','command_conflict'].includes(v.state))throw Error('atomic_assignment_invalid_response');return v;}
 return {
  snapshot:async(account:string,conversation:string)=>{const v=await post('snapshot',{account_id:account,conversation_id:conversation});if(!validSnapshot(v.snapshot)||v.snapshot.account_id!==account||v.snapshot.conversation_id!==conversation)throw Error('atomic_assignment_invalid_snapshot');return v.snapshot;},
  assign:async(command:AssignmentCommand)=>result(await post('assign',command),command.command_id),
  receipt:async(account:string,id:string)=>result(await post('receipt',{account_id:account,command_id:id}),id)
 };
}
export function atomicAssignment(){return createAtomicAssignment({baseUrl:requiredEnv('CHATWOOT_BASE_URL'),secret:assignmentSecret()});}
