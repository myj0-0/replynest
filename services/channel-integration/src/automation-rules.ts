import type {PoolClient} from 'pg';
import type {AuthContext} from './business-api.js';
import {exactObject,ExtensionError} from './extension-core.js';
import {validateRule,ruleMembers,nextRuleRun,planPermissions,schedulePermissions,rulePermissions,scheduledAssignmentEnabled,messageEventsEnabled,uuidPattern} from './automation-rule-core.js';
import type {AutomationPreview} from './automation-preview.js';
import {assignmentEnabled} from './atomic-assignment.js';

export const planningEnabled=()=>process.env.AUTOMATION_PLANNING_ENABLED==='true';
export function isRulePath(path:string[]){return path.length===1&&path[0]==='automation-rules'||path.length===2&&['rule-versions','rule-publish','rule-pause','rule-runs','rule-plan'].includes(path[1]);}
export async function validateRuleMembers(c:Pick<PoolClient,'query'>,tenant:string,d:AutomationPreview){
 const ids=ruleMembers(d);
 const members=await c.query(`SELECT m.platform_user_id::text FROM tenant_memberships m JOIN platform_users u USING(platform_user_id) JOIN tenants t USING(tenant_id)
 WHERE m.tenant_id=$1 AND m.platform_user_id=ANY($2::uuid[]) AND m.status='active' AND u.status='active'
 AND m.chatwoot_sync_status='synced' AND m.chatwoot_user_id IS NOT NULL AND m.chatwoot_account_id=t.chatwoot_account_id`,[tenant,ids]);
 if(members.rowCount!==ids.length)throw new ExtensionError('rule_member_unavailable',409);
}
export async function handleRule(c:PoolClient,auth:AuthContext,path:string[],method:string,body:Record<string,unknown>,requestId:string){
 const tenant=auth.tenant_id;
 const audit=async(action:string,id:string,data:unknown)=>{await c.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id) VALUES($1,'platform_user',$2,$3,'automation_rule',$4,$5::jsonb,$6)`,[tenant,auth.actor_id,`automation.${action}`,id,JSON.stringify(data),requestId]);};
 if(path.length===1){
  if(method==='GET'){
   const rules=await c.query('SELECT * FROM tenant_automation_rules WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 20',[tenant]);
   const members=await c.query(`SELECT m.platform_user_id::text AS member_id,u.display_name FROM tenant_memberships m JOIN platform_users u USING(platform_user_id) JOIN tenants t USING(tenant_id) WHERE m.tenant_id=$1 AND m.status='active' AND u.status='active' AND m.chatwoot_sync_status='synced' AND m.chatwoot_user_id IS NOT NULL AND m.chatwoot_account_id=t.chatwoot_account_id ORDER BY u.display_name`,[tenant]);
   return {rules:rules.rows,members:members.rows,permissions:planPermissions,schedule_permissions:schedulePermissions,planning_enabled:planningEnabled(),execution_enabled:assignmentEnabled(),message_execution_enabled:messageEventsEnabled()&&assignmentEnabled()&&planningEnabled(),schedule_execution_enabled:scheduledAssignmentEnabled()&&assignmentEnabled()&&planningEnabled()};
  }
  if(method!=='POST')throw new ExtensionError('not_found',404);
  exactObject(body,['definition','rule_id','expected_revision']);const d=validateRule(body.definition);await validateRuleMembers(c,tenant,d);
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`automation-rules:${tenant}`]);
  let id:string,revision:number;
  if(body.rule_id!==undefined){
   if(typeof body.rule_id!=='string'||!uuidPattern.test(body.rule_id))throw new ExtensionError('invalid_rule');
   const current=(await c.query('SELECT * FROM tenant_automation_rules WHERE tenant_id=$1 AND rule_id=$2 FOR UPDATE',[tenant,body.rule_id])).rows[0];
   if(!current)throw new ExtensionError('not_found',404);if(current.revision!==body.expected_revision)throw new ExtensionError('version_conflict',409);
   id=body.rule_id;revision=current.revision+1;if(revision>100)throw new ExtensionError('version_limit',429);
   await c.query('UPDATE tenant_automation_rules SET revision=$3,updated_at=NOW() WHERE tenant_id=$1 AND rule_id=$2',[tenant,id,revision]);
  }else{
   if(body.expected_revision!==undefined)throw new ExtensionError('invalid_rule');
   const count=(await c.query('SELECT count(*)::int AS n FROM tenant_automation_rules WHERE tenant_id=$1',[tenant])).rows[0].n;
   if(count>=20)throw new ExtensionError('rule_limit',429);
   id=(await c.query('INSERT INTO tenant_automation_rules(tenant_id,name) VALUES($1,$2) RETURNING rule_id',[tenant,d.name])).rows[0].rule_id;revision=1;
  }
  await c.query('INSERT INTO tenant_automation_rule_versions(tenant_id,rule_id,revision,definition,created_by) VALUES($1,$2,$3,$4::jsonb,$5)',[tenant,id,revision,JSON.stringify(d),auth.actor_id]);
  await audit('draft_saved',id,{revision});return {rule_id:id,revision};
 }
 const id=path[0];if(!uuidPattern.test(id))throw new ExtensionError('not_found',404);
 const rule=(await c.query('SELECT * FROM tenant_automation_rules WHERE tenant_id=$1 AND rule_id=$2 FOR UPDATE',[tenant,id])).rows[0];
 if(!rule)throw new ExtensionError('not_found',404);
 if(method==='GET'&&path[1]==='rule-versions')return {rule,versions:(await c.query('SELECT revision,definition,created_at FROM tenant_automation_rule_versions WHERE tenant_id=$1 AND rule_id=$2 ORDER BY revision DESC LIMIT 100',[tenant,id])).rows};
 if(method==='GET'&&path[1]==='rule-runs')return {runs:(await c.query(`SELECT tenant_id,rule_id,run_id,revision,scheduled_at,state,source,result,created_at,started_at,completed_at,
  schedule_grant_id,schedule_execution_state,schedule_execution_code FROM tenant_automation_plan_runs
  WHERE tenant_id=$1 AND rule_id=$2 ORDER BY created_at DESC LIMIT 30`,[tenant,id])).rows};
 if(method!=='POST')throw new ExtensionError('not_found',404);
 if(path[1]==='rule-pause'){
  exactObject(body,[]);await c.query('UPDATE tenant_automation_rules SET enabled=false,schedule_grant_id=NULL,next_run_at=NULL,updated_at=NOW() WHERE tenant_id=$1 AND rule_id=$2',[tenant,id]);
  await c.query("UPDATE tenant_automation_plan_runs SET state='cancelled',completed_at=NOW() WHERE tenant_id=$1 AND rule_id=$2 AND state='pending'",[tenant,id]);
  await audit('paused',id,{});return {enabled:false};
 }
 if(!planningEnabled())throw new ExtensionError('planning_disabled',503);
 if(path[1]==='rule-publish'){
  exactObject(body,['revision','expected_active_revision','permissions','confirm','execution_mode']);
  const eventMode=body.execution_mode==='message_event',automatic=body.execution_mode==='scheduled'||eventMode;
  if(body.execution_mode!==undefined&&!['plan_only','scheduled','message_event'].includes(String(body.execution_mode)))throw new ExtensionError('invalid_definition');
  if(automatic&&(!(eventMode?messageEventsEnabled():scheduledAssignmentEnabled())||!assignmentEnabled()))throw new ExtensionError('schedule_execution_disabled',503);
  if(body.expected_active_revision!==rule.active_revision)throw new ExtensionError('version_conflict',409);
  if(!Number.isSafeInteger(body.revision))throw new ExtensionError('invalid_version');
  const version=(await c.query('SELECT definition FROM tenant_automation_rule_versions WHERE tenant_id=$1 AND rule_id=$2 AND revision=$3',[tenant,id,body.revision])).rows[0];if(!version)throw new ExtensionError('not_found',404);
  const d=validateRule(version.definition);await validateRuleMembers(c,tenant,d);
  const permissions=rulePermissions(d,automatic);
  if(body.confirm!==true||JSON.stringify(body.permissions)!==JSON.stringify(permissions))throw new ExtensionError('permission_confirmation_required');
  if(automatic&&d.trigger!==(eventMode?'message_received':'weekly'))throw new ExtensionError('schedule_rule_unsupported',400);
  if(d.semantic&&process.env.AI_POINTS_ENABLED!=='true')throw new ExtensionError('semantic_points_required',503);
  const next=nextRuleRun(d,new Date());
  await c.query('UPDATE tenant_automation_rules SET enabled=true,active_revision=$3,approved_by=$4,next_run_at=$5,name=$6,schedule_grant_id=CASE WHEN $7 THEN gen_random_uuid() ELSE NULL END,execution_authorized_at=NOW(),updated_at=NOW() WHERE tenant_id=$1 AND rule_id=$2',[tenant,id,body.revision,auth.actor_id,next,d.name,automatic]);
  await c.query("UPDATE tenant_automation_plan_runs SET state='cancelled',completed_at=NOW() WHERE tenant_id=$1 AND rule_id=$2 AND state='pending'",[tenant,id]);
  await audit('plan_published',id,{revision:body.revision,permissions,next_run_at:next,execution_mode:eventMode?'message_event':automatic?'scheduled':'plan_only'});return {enabled:true,next_run_at:next,execution_enabled:automatic};
 }
 if(path[1]==='rule-plan'){
  exactObject(body,[]);if(!rule.enabled||!rule.active_revision)throw new ExtensionError('rule_not_active',409);
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`automation-plan-budget:${tenant}`]);
  const recent=await c.query("SELECT 1 FROM tenant_automation_plan_runs WHERE tenant_id=$1 AND created_at>NOW()-INTERVAL '1 minute' LIMIT 1",[tenant]);if(recent.rowCount)throw new ExtensionError('plan_rate_limited',429);
  const run=(await c.query("INSERT INTO tenant_automation_plan_runs(tenant_id,rule_id,revision,scheduled_at,state,source) VALUES($1,$2,$3,NOW(),'pending','manual') RETURNING run_id",[tenant,id,rule.active_revision])).rows[0];
  await audit('plan_requested',id,run);return run;
 }
 throw new ExtensionError('not_found',404);
}
