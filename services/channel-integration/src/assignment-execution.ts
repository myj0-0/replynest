import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {pool} from './database.js';
import type {AuthContext} from './business-api.js';
import {ExtensionError,exactObject} from './extension-core.js';
import {assignmentEnabled,atomicAssignment,validSnapshot,type AssignmentCommand} from './atomic-assignment.js';
import {uuidPattern,validateRule,scheduledAssignmentEnabled,messageEventsEnabled} from './automation-rule-core.js';
import {validateRuleMembers,planningEnabled} from './automation-rules.js';
const active=()=>assignmentEnabled()&&planningEnabled()&&process.env.EXTENSION_BUILDER_ENABLED==='true';
export async function assignmentAction(c:PoolClient,auth:Pick<AuthContext,'tenant_id'|'actor_id'>,id:string,action:string,body:Record<string,unknown>,scheduledGrant?:string){
 if(!uuidPattern.test(id))throw new ExtensionError('not_found',404);
 const run=(await c.query(`SELECT p.*,r.enabled,r.active_revision,r.schedule_grant_id AS current_schedule_grant_id,r.approved_by,v.definition FROM tenant_automation_plan_runs p JOIN tenant_automation_rules r USING(tenant_id,rule_id) JOIN tenant_automation_rule_versions v ON v.tenant_id=p.tenant_id AND v.rule_id=p.rule_id AND v.revision=p.revision WHERE p.tenant_id=$1 AND p.run_id=$2 FOR UPDATE OF p,r`,[auth.tenant_id,id])).rows[0];
 if(!run)throw new ExtensionError('not_found',404);
 if(action==='execution-status')return {commands:(await c.query('SELECT command_id,conversation_id,state,updated_at FROM tenant_assignment_commands WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at',[auth.tenant_id,id])).rows};
 if(!active())throw new ExtensionError('assignment_disabled',503);
 if(scheduledGrant&&(!(run.source==='event'?messageEventsEnabled():run.source==='schedule'&&scheduledAssignmentEnabled())||run.schedule_grant_id!==scheduledGrant||run.current_schedule_grant_id!==scheduledGrant||run.approved_by!==auth.actor_id))throw new ExtensionError('schedule_authorization_revoked',409);
 if(action==='reconcile-plan'){
  exactObject(body,[]);
  // No re-dispatch: the worker only queries receipts for uncertain commands.
  return {reconciliation:'receipt_only',commands:(await c.query("SELECT command_id,state FROM tenant_assignment_commands WHERE tenant_id=$1 AND run_id=$2",[auth.tenant_id,id])).rows};
 }
 exactObject(body,['confirm','permission']);if(body.confirm!==true||body.permission!=='conversation.assign_plan')throw new ExtensionError('permission_confirmation_required');
 if(!run.enabled||run.active_revision!==run.revision||run.state!=='completed')throw new ExtensionError('plan_not_executable',409);
 if(Date.now()-new Date(run.completed_at).getTime()>5*60000)throw new ExtensionError('plan_expired',409);
 const d=validateRule(run.definition);
 await validateRuleMembers(c,auth.tenant_id,d);
 const items=run.result.items.filter((i:{reason:string})=>i.reason==='would_assign');if((!items.length&&!scheduledGrant)||items.length>d.max_actions)throw new ExtensionError('plan_not_executable',409);
 for(const item of items){
  if(!validSnapshot(item.execution_snapshot)||item.execution_snapshot.bot_id!==null)throw new ExtensionError('plan_snapshot_required',409);
  const member=(await c.query(`SELECT m.chatwoot_user_id::text AS user_id,t.chatwoot_account_id::text AS account_id FROM tenant_memberships m JOIN tenants t USING(tenant_id) WHERE m.tenant_id=$1 AND m.platform_user_id=$2 AND m.chatwoot_account_id=t.chatwoot_account_id`,[auth.tenant_id,item.target_member_id])).rows[0];
  if(!member)throw new ExtensionError('plan_not_executable',409);
  const mapping=(await c.query("SELECT chatwoot_resource_id FROM conversation_resource_mappings WHERE tenant_id=$1 AND replynest_resource_id=$2 AND resource_type='conversation' AND chatwoot_account_id=$3",[auth.tenant_id,item.conversation_id,member.account_id])).rows[0];
  if(!member||!mapping||member.account_id!==item.execution_snapshot.account_id||mapping.chatwoot_resource_id!==item.execution_snapshot.conversation_id)throw new ExtensionError('plan_not_executable',409);
  const command:AssignmentCommand={command_id:randomUUID(),account_id:member.account_id,conversation_id:mapping.chatwoot_resource_id,target_user_id:member.user_id,snapshot:item.execution_snapshot};
  await c.query(`INSERT INTO tenant_assignment_commands(tenant_id,command_id,run_id,conversation_id,approved_by,request,target_member_id,schedule_grant_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(tenant_id,run_id,conversation_id) DO NOTHING`,[auth.tenant_id,command.command_id,id,item.conversation_id,auth.actor_id,JSON.stringify(command),item.target_member_id,scheduledGrant??null]);
 }
 await c.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id) VALUES($1,'platform_user',$2,'automation.execution_approved','automation_plan',$3::uuid::text,$4::jsonb,$3::uuid)`,[auth.tenant_id,auth.actor_id,id,JSON.stringify({count:items.length,permission:scheduledGrant?'conversation.assign_scheduled':'conversation.assign_plan',schedule_grant_id:scheduledGrant??null})]);
 return {queued:true,count:items.length};
}
// Only runs born under an explicit scheduled grant are eligible. Old read-only plans never auto-promote.
async function queueScheduledAssignments(c:PoolClient){
 if(!scheduledAssignmentEnabled()&&!messageEventsEnabled())return;
 const runs=(await c.query(`SELECT p.tenant_id,p.run_id,p.schedule_grant_id,r.approved_by FROM tenant_automation_plan_runs p JOIN tenant_automation_rules r USING(tenant_id,rule_id) WHERE p.source IN('schedule','event') AND p.schedule_grant_id IS NOT NULL AND p.schedule_execution_state IS NULL AND p.state NOT IN ('pending','running') ORDER BY p.completed_at,p.run_id LIMIT 20`)).rows;
 for(const run of runs){
  await c.query('BEGIN');
  try{
   await c.query('SAVEPOINT schedule_dispatch');
   let state='queued',code:string|null=null;
   try{await assignmentAction(c,{tenant_id:run.tenant_id,actor_id:run.approved_by},run.run_id,'execute-plan',{confirm:true,permission:'conversation.assign_plan'},run.schedule_grant_id);}
   catch(e){if(!(e instanceof ExtensionError))throw e;await c.query('ROLLBACK TO SAVEPOINT schedule_dispatch');state='skipped';code=e.code;}
   await c.query('UPDATE tenant_automation_plan_runs SET schedule_execution_state=$3,schedule_execution_code=$4 WHERE tenant_id=$1 AND run_id=$2',[run.tenant_id,run.run_id,state,code]);
   await c.query('COMMIT');
  }catch{await c.query('ROLLBACK');throw Error('schedule_dispatch_failed');}
 }
}
export async function processAssignmentCommands(injected?:ReturnType<typeof atomicAssignment>){
 if(!active())return;const transport=injected??atomicAssignment();const c=await pool.connect();let locked=false;
 try{
  locked=(await c.query("SELECT pg_try_advisory_lock(hashtext('assignment-executor-v1')) AS locked")).rows[0].locked;if(!locked)return;
  await queueScheduledAssignments(c);
  // This lock excludes live workers: leftover sending rows have unknown outcomes.
  await c.query("UPDATE tenant_assignment_commands SET state='uncertain',updated_at=NOW() WHERE state='sending'");
  const rows=(await c.query("SELECT * FROM tenant_assignment_commands WHERE state='pending' OR (state='uncertain' AND updated_at<NOW()-INTERVAL '1 minute') ORDER BY created_at LIMIT 10")).rows;
  for(const command of rows){
   if(!active())break;
   let state='uncertain';
   if(command.state==='uncertain'){
    try{state=(await transport.receipt(command.request.account_id,command.command_id)).state;}catch{/* Never resend an uncertain write. */}
   }else{
    const grant=(await c.query(`SELECT r.enabled,r.active_revision,r.schedule_grant_id,p.source,p.revision,p.state,p.completed_at,v.definition,t.chatwoot_account_id::text AS account_id FROM tenant_automation_plan_runs p JOIN tenant_automation_rules r USING(tenant_id,rule_id) JOIN tenant_automation_rule_versions v ON v.tenant_id=p.tenant_id AND v.rule_id=p.rule_id AND v.revision=p.revision JOIN tenants t ON t.tenant_id=p.tenant_id JOIN tenant_memberships m ON m.tenant_id=p.tenant_id AND m.platform_user_id=$3 JOIN platform_users u ON u.platform_user_id=m.platform_user_id JOIN tenant_memberships publisher ON publisher.tenant_id=p.tenant_id AND publisher.platform_user_id=r.approved_by JOIN platform_users pu ON pu.platform_user_id=publisher.platform_user_id WHERE p.tenant_id=$1 AND p.run_id=$2 AND m.status='active' AND m.role='tenant_admin' AND u.status='active' AND publisher.status='active' AND publisher.role='tenant_admin' AND pu.status='active' AND t.status IN ('active','test')`,[command.tenant_id,command.run_id,command.approved_by])).rows[0];
    if(!grant||!grant.enabled||grant.active_revision!==grant.revision||grant.state!=='completed'||grant.account_id!==command.request.account_id||Date.now()-new Date(grant.completed_at).getTime()>5*60000){state='cancelled';}
    else if(command.schedule_grant_id&&(!(grant.source==='event'?messageEventsEnabled():scheduledAssignmentEnabled())||grant.schedule_grant_id!==command.schedule_grant_id)){state='cancelled';}
    else{
     try{await validateRuleMembers(c,command.tenant_id,validateRule(grant.definition));
      const target=await c.query(`SELECT 1 FROM tenant_memberships m JOIN platform_users u USING(platform_user_id) WHERE m.tenant_id=$1 AND m.chatwoot_account_id=$2 AND m.chatwoot_user_id::text=$3 AND m.platform_user_id=$4 AND m.status='active' AND m.chatwoot_sync_status='synced' AND u.status='active'`,[command.tenant_id,command.request.account_id,command.request.target_user_id,command.target_member_id]);
      if(!target.rowCount)throw Error('member_revoked');
      const mapping=await c.query("SELECT 1 FROM conversation_resource_mappings WHERE tenant_id=$1 AND replynest_resource_id=$2 AND resource_type='conversation' AND chatwoot_account_id=$3 AND chatwoot_resource_id=$4",[command.tenant_id,command.conversation_id,command.request.account_id,command.request.conversation_id]);if(!mapping.rowCount)throw Error('mapping_changed');
     }catch{state='cancelled';}
     if(state!=='cancelled'){
      await c.query("UPDATE tenant_assignment_commands SET state='sending',updated_at=NOW() WHERE tenant_id=$1 AND command_id=$2",[command.tenant_id,command.command_id]);
      try{state=(await transport.assign(command.request)).state;}catch{state='uncertain';}
     }
    }
   }
   await c.query('BEGIN');try{
    await c.query('UPDATE tenant_assignment_commands SET state=$3,updated_at=NOW() WHERE tenant_id=$1 AND command_id=$2',[command.tenant_id,command.command_id,state]);
    await c.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id) VALUES($1,'system','assignment-executor','automation.assignment_result','conversation',$2,$3::jsonb,$4)`,[command.tenant_id,command.conversation_id,JSON.stringify({command_id:command.command_id,state}),command.run_id]);
    await c.query('COMMIT');
   }catch{await c.query('ROLLBACK');throw Error('assignment_result_failed');}
  }
 }finally{if(locked)await c.query("SELECT pg_advisory_unlock(hashtext('assignment-executor-v1'))");c.release();}
}
