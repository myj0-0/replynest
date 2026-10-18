import type {Pool,PoolClient} from 'pg';
import type {AutomaticInbound} from './automatic-reception-queue.js';
import {ensureConversationMapping} from './conversation-mapping.js';
import {messageEventsEnabled} from './automation-rule-core.js';
import {assignmentEnabled} from './atomic-assignment.js';
import {planningEnabled} from './automation-rules.js';

// Only server bindings determine ownership. Shared inboxes also require the
// tenant-specific thread; the global public-account ID is never a tenant ID.
export async function studioEventBinding(c:Pick<PoolClient,'query'>,e:AutomaticInbound){
 const rows=await c.query(`SELECT DISTINCT t.tenant_id FROM tenants t WHERE t.chatwoot_account_id::text=$1
 AND t.status IN('active','test') AND (
 EXISTS(SELECT 1 FROM channel_connections ch WHERE ch.tenant_id=t.tenant_id AND ch.status='ready'
  AND ch.channel_type IN('web_chat','wechat_official_account') AND ch.configuration->>'chatwoot_account_id'=$1
  AND ch.configuration->>'chatwoot_inbox_id'=$2)
 OR EXISTS(SELECT 1 FROM shared_wechat_threads b JOIN shared_wechat_enrollments en ON en.tenant_id=b.tenant_id AND en.app_id=b.app_id
  WHERE b.tenant_id=t.tenant_id AND b.account_id::text=$1 AND b.inbox_id::text=$2 AND b.conversation_id::text=$3 AND en.enabled)) LIMIT 2`,[e.account,e.inbox,e.conversation]);
 return rows.rows.length===1?rows.rows[0].tenant_id as string:null;
}
export const studioEventsActive=()=>messageEventsEnabled()&&assignmentEnabled()&&planningEnabled()&&process.env.EXTENSION_BUILDER_ENABLED==='true';
/** Signed public incoming event -> durable queue. No transcript, AI or upstream write in callback. */
export async function enqueueStudioMessageEvent(db:Pick<Pool,'connect'>,e:AutomaticInbound){
 if(!studioEventsActive())return;
 const c=await db.connect();
 try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms'");
  const tenant=await studioEventBinding(c,e);if(!tenant){await c.query('COMMIT');return;}
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`automation-plan-budget:${tenant}`]);
  const rules=(await c.query(`SELECT r.* FROM tenant_automation_rules r
   JOIN tenant_automation_rule_versions v ON v.tenant_id=r.tenant_id AND v.rule_id=r.rule_id AND v.revision=r.active_revision
   JOIN tenant_memberships m ON m.tenant_id=r.tenant_id AND m.platform_user_id=r.approved_by JOIN platform_users u USING(platform_user_id)
   WHERE r.tenant_id=$1 AND r.enabled AND r.schedule_grant_id IS NOT NULL AND r.execution_authorized_at IS NOT NULL
   AND v.definition->>'trigger'='message_received' AND m.status='active' AND m.role='tenant_admin' AND u.status='active'
   ORDER BY r.rule_id LIMIT 20 FOR SHARE OF r,m,u`,[tenant])).rows;
  const pending=Number((await c.query("SELECT count(*)::int n FROM tenant_automation_plan_runs WHERE tenant_id=$1 AND state IN('pending','running')",[tenant])).rows[0].n);
  const newRules=[];
  for(const rule of rules)if(!(await c.query("SELECT 1 FROM tenant_automation_plan_runs WHERE tenant_id=$1 AND rule_id=$2 AND source='event' AND event_message_id=$3",[tenant,rule.rule_id,e.message])).rowCount)newRules.push(rule);
  if(pending+newRules.length>100)throw Error('studio_event_backpressure');
  if(newRules.length&&studioEventsActive()){
   const mapped=await ensureConversationMapping(c,tenant,'conversation',e.account,e.conversation);
   for(const rule of newRules)await c.query(`INSERT INTO tenant_automation_plan_runs
    (tenant_id,rule_id,revision,scheduled_at,state,source,schedule_grant_id,event_message_id,event_conversation_id,event_inbox_id)
    VALUES($1,$2,$3,clock_timestamp(),'pending','event',$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [tenant,rule.rule_id,rule.active_revision,rule.schedule_grant_id,e.message,mapped,e.inbox]);
  }
  await c.query('COMMIT');
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
