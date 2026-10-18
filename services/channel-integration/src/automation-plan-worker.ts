import {pool} from './database.js';
import {claimAutomationPlan,finishAutomationPlan,PLAN_CONCURRENCY,serializeAutomationClaim,type PlanLease} from './automation-plan-queue.js';
import {getChatwootConversation,listChatwootMessages,type ChatwootRecord} from './conversation-headless-chatwoot.js';
import {planningEnabled,validateRuleMembers} from './automation-rules.js';
import {recordPlanOutcome} from './automation-runtime-health.js';
import {validateRule,nextRuleRun,ruleTarget} from './automation-rule-core.js';
import {simulateAutomation} from './automation-preview.js';
import {assignmentEnabled,atomicAssignment,type AssignmentSnapshot} from './atomic-assignment.js';
import {classifyRouting,type RoutingClassifier} from './automation-routing.js';
import {messageEventsEnabled} from './automation-rule-core.js';
import {studioEventBinding} from './studio-message-events.js';

// Read-only transport by construction: no assignment, message or payment adapter.
export type PlanTransport={conversation:(account:string,id:string)=>Promise<ChatwootRecord>;messages:(account:string,id:string)=>Promise<ChatwootRecord[]>;snapshot?:(account:string,id:string)=>Promise<AssignmentSnapshot>;classify?:RoutingClassifier};
const live:PlanTransport={conversation:getChatwootConversation,messages:listChatwootMessages,snapshot:(a,id)=>atomicAssignment().snapshot(a,id)};
const enabled=()=>planningEnabled()&&process.env.EXTENSION_BUILDER_ENABLED==='true';
export async function enqueueAutomationPlans(){
 if(!enabled())return;
 const c=await pool.connect();let locked=false;
 try{
  locked=(await c.query("SELECT pg_try_advisory_lock(hashtext('automation-plan-worker-v1')) AS locked")).rows[0].locked;if(!locked)return;
  const deadline=Date.now()+1000;let admitted=0;
  while(enabled()&&Date.now()<deadline&&admitted<200){
  await c.query('BEGIN READ ONLY');
  let due;
  try{
   await c.query("SET LOCAL statement_timeout='3s'");await c.query("SET LOCAL lock_timeout='500ms'");
   due=(await c.query(`SELECT r.*,v.definition FROM tenant_automation_rules r JOIN tenant_automation_rule_versions v ON v.tenant_id=r.tenant_id AND v.rule_id=r.rule_id AND v.revision=r.active_revision WHERE r.enabled AND r.next_run_at<=NOW() ORDER BY r.next_run_at,r.tenant_id,r.rule_id LIMIT 20`)).rows;
   await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}
  if(!due.length)break;
  for(const rule of due){
   if(!enabled()||Date.now()>=deadline||admitted>=200)break;
   admitted++;
   await c.query('BEGIN');
   try{
    await c.query("SET LOCAL statement_timeout='3s'");await c.query("SET LOCAL lock_timeout='500ms'");
    const current=(await c.query('SELECT * FROM tenant_automation_rules WHERE tenant_id=$1 AND rule_id=$2 FOR UPDATE',[rule.tenant_id,rule.rule_id])).rows[0];
    if(current.enabled&&current.active_revision===rule.active_revision&&current.next_run_at?.getTime()===rule.next_run_at.getTime()){
     const missed=Date.now()-rule.next_run_at.getTime()>5*60_000;
     await c.query(`INSERT INTO tenant_automation_plan_runs(tenant_id,rule_id,revision,scheduled_at,state,source,completed_at,schedule_grant_id) VALUES($1,$2,$3,$4,$5,'schedule',CASE WHEN $5='missed' THEN NOW() ELSE NULL END,$6) ON CONFLICT(tenant_id,rule_id,scheduled_at) DO NOTHING`,[rule.tenant_id,rule.rule_id,rule.active_revision,rule.next_run_at,missed?'missed':'pending',current.schedule_grant_id]);
     await c.query('UPDATE tenant_automation_rules SET next_run_at=$3 WHERE tenant_id=$1 AND rule_id=$2',[rule.tenant_id,rule.rule_id,nextRuleRun(validateRule(rule.definition),new Date())]);
    }
    await c.query('COMMIT');
   }catch{await c.query('ROLLBACK');throw new Error('plan_schedule_failed');}
  }
  }
  await c.query('BEGIN');
  try{
   await c.query("SET LOCAL statement_timeout='3s'");await c.query("SET LOCAL lock_timeout='500ms'");
   await c.query(`UPDATE tenant_automation_plan_runs SET state='missed',completed_at=NOW() WHERE (tenant_id,run_id) IN
    (SELECT tenant_id,run_id FROM tenant_automation_plan_runs WHERE state='pending' AND source IN('schedule','event') AND scheduled_at<NOW()-INTERVAL '5 minutes' LIMIT 500) AND state='pending'`);
   await c.query(`UPDATE tenant_automation_plan_runs SET state='cancelled',completed_at=NOW() WHERE (tenant_id,run_id) IN
    (SELECT tenant_id,run_id FROM tenant_automation_plan_runs WHERE state='pending' AND source='manual' AND created_at<NOW()-INTERVAL '15 minutes' LIMIT 500) AND state='pending'`);
   await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}
  return {retrySoon:admitted>0,admitted};
 }finally{try{if(locked)await c.query("SELECT pg_advisory_unlock(hashtext('automation-plan-worker-v1'))");}finally{c.release();}}
}

type ClaimedPlan=PlanLease&{rule_id:string;revision:number;source:string;scheduled_at:Date;schedule_grant_id:string|null;event_message_id?:string;event_conversation_id?:string;event_inbox_id?:string};
async function planOne(run:ClaimedPlan,transport:PlanTransport){
  // Pool queries release their connection before network waits.
  const c=pool,deadline=Date.now()+45_000;
  const read=async<T>(operation:()=>Promise<T>):Promise<T>=>{
   const remaining=Math.min(10_000,deadline-Date.now());
   if(remaining<=0)throw Error('plan_time_limit');
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{return await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('plan_read_timeout')),remaining);})]);}
   finally{if(timer)clearTimeout(timer);}
  };
  const authorize=async()=>{
   if(!enabled()||(run.source==='event'&&!messageEventsEnabled()))return null;
   return (await c.query(`SELECT r.*,t.chatwoot_account_id::text AS account_id,v.definition FROM tenant_automation_rules r JOIN tenants t USING(tenant_id)
    JOIN tenant_automation_rule_versions v ON v.tenant_id=r.tenant_id AND v.rule_id=r.rule_id AND v.revision=r.active_revision
    JOIN tenant_memberships m ON m.tenant_id=r.tenant_id AND m.platform_user_id=r.approved_by JOIN platform_users u ON u.platform_user_id=m.platform_user_id
    WHERE r.tenant_id=$1 AND r.rule_id=$2 AND r.enabled AND r.active_revision=$3 AND t.status IN ('active','test') AND t.chatwoot_account_id IS NOT NULL
    AND m.status='active' AND m.role='tenant_admin' AND u.status='active'
    AND EXISTS(SELECT 1 FROM tenant_automation_plan_runs p WHERE p.tenant_id=r.tenant_id AND p.run_id=$4
     AND p.state='running' AND p.lease_token=$5 AND p.lease_expires_at>clock_timestamp()
     AND (p.source<>'event' OR p.schedule_grant_id=r.schedule_grant_id))`,[run.tenant_id,run.rule_id,run.revision,run.run_id,run.lease_token])).rows[0]??null;
  };
  const results:{conversation_id:string;reason:string;target_member_id:string|null;expected_assignee_id:string|null;execution_snapshot?:AssignmentSnapshot}[]=[];
  let state='completed',code:string|null=null,planned=0,scanned=0,scanLimited=false,at:string|null=null,classified=0;
  try{
   const rule=await authorize();if(!rule){state='cancelled';code='authorization_revoked';}
   else{
    const d=validateRule(rule.definition);await validateRuleMembers(c,run.tenant_id,d);
    at=run.source==='manual'&&d.trigger==='weekly'?nextRuleRun(d,new Date(run.scheduled_at)):new Date(run.scheduled_at).toISOString();
    if(!at)throw new Error('plan_time_unavailable');const target=ruleTarget(d,new Date(at));if(!target)throw new Error('plan_target_unavailable');
    const candidates=(await c.query(`SELECT replynest_resource_id::text,chatwoot_resource_id FROM conversation_resource_mappings WHERE tenant_id=$1 AND resource_type='conversation' AND chatwoot_account_id=$2 AND ($3::uuid IS NULL OR replynest_resource_id=$3) ORDER BY created_at DESC,replynest_resource_id LIMIT 101`,[run.tenant_id,rule.account_id,run.source==='event'?run.event_conversation_id:null])).rows;
    scanLimited=candidates.length>100;
    for(const mapping of candidates.slice(0,100)){
     if(Date.now()>deadline){state='partial';code='time_limit';break;}
     const fresh=await authorize();if(!fresh||fresh.account_id!==rule.account_id){state='cancelled';code='authorization_revoked';break;}
     await validateRuleMembers(c,run.tenant_id,d);
     try{
      const raw=await read(()=>transport.conversation(rule.account_id,mapping.chatwoot_resource_id));
      if(!await authorize()){state='cancelled';code='authorization_revoked';break;}
      if(String(raw.account_id)!==rule.account_id||String(raw.id)!==mapping.chatwoot_resource_id)throw new Error('boundary_mismatch');
      if(run.source==='event'&&(String(raw.inbox_id)!==run.event_inbox_id||await studioEventBinding(c,{account:rule.account_id,inbox:run.event_inbox_id!,conversation:mapping.chatwoot_resource_id,message:run.event_message_id!})!==run.tenant_id))throw Error('event_binding_changed');
      const meta=raw.meta as ChatwootRecord|undefined,assignee=meta?.assignee as ChatwootRecord|undefined;
      const upstreamAssignee=assignee?.id==null?null:String(assignee.id);
      let assigned:string|null=null;
      if(upstreamAssignee){assigned=(await c.query('SELECT platform_user_id::text FROM tenant_memberships WHERE tenant_id=$1 AND chatwoot_account_id=$2 AND chatwoot_user_id::text=$3',[run.tenant_id,rule.account_id,upstreamAssignee])).rows[0]?.platform_user_id??'unmapped';}
      let text='';
      let routingSnapshot:AssignmentSnapshot|undefined;
      if((d.keywords.length||d.semantic)&&assignmentEnabled()&&transport.snapshot){
       routingSnapshot=await read(()=>transport.snapshot!(rule.account_id,mapping.chatwoot_resource_id));
      }
      if(d.keywords.length||d.semantic){
       const messages=await read(()=>transport.messages(rule.account_id,mapping.chatwoot_resource_id));
       const incoming=messages.filter(m=>m.private===false&&(m.message_type===0||m.message_type==='incoming')&&String(m.conversation_id)===mapping.chatwoot_resource_id&&(m.account_id==null||String(m.account_id)===rule.account_id));
       incoming.sort((a,b)=>Number(b.created_at)-Number(a.created_at)||Number(b.id)-Number(a.id));
       const latest=incoming[0];
       if(run.source==='event'&&(!latest||String(latest.id)!==run.event_message_id||!Number.isFinite(Number(latest.created_at))||Number(latest.created_at)*1000<new Date(rule.execution_authorized_at).getTime())){
        results.push({conversation_id:mapping.replynest_resource_id,reason:'event_stale_or_superseded',target_member_id:null,expected_assignee_id:null});continue;
       }
       text=String(latest?.content??'').slice(0,4000);
      }
      scanned++;
      const s=String(raw.status);let reason='status_excluded';
      let classification:{label:string;confidence:number;matched:boolean}|undefined;
      if(['open','pending','resolved'].includes(s)){
       const sample={id:mapping.replynest_resource_id,text,status:s,assignee_ref:assigned};
       reason=simulateAutomation(d,[sample],at).results[0].reason;
       if(reason==='semantic_requires_ai'){
        if(classified>=10){state='partial';code='classification_limit';break;}
        if(!await authorize()){state='cancelled';code='authorization_revoked';break;}
        classified++;
        classification=await read(()=>(transport.classify??classifyRouting)(run.tenant_id,d.semantic!,text));
        if(!await authorize()){state='cancelled';code='authorization_revoked';break;}
        reason=simulateAutomation(d,[sample],at,new Map([[sample.id,classification.matched]])).results[0].reason;
       }
       if(reason==='would_assign'&&planned>=d.max_actions)reason='action_limit';
      }
      let execution_snapshot:AssignmentSnapshot|undefined;
      if(reason==='would_assign'&&assignmentEnabled()&&transport.snapshot){
       if(!await authorize()){state='cancelled';code='authorization_revoked';break;}
       const snapshot=await read(()=>transport.snapshot!(rule.account_id,mapping.chatwoot_resource_id));
       if(snapshot.status!==s||snapshot.assignee_id!==upstreamAssignee||snapshot.bot_id!==null||(routingSnapshot&&JSON.stringify(snapshot)!==JSON.stringify(routingSnapshot)))reason='state_changed';else execution_snapshot=snapshot;
      }
      if(reason==='would_assign')planned++;
      results.push({conversation_id:mapping.replynest_resource_id,reason,target_member_id:reason==='would_assign'?target:null,expected_assignee_id:assigned,...(execution_snapshot?{execution_snapshot}:{}),...(classification?{classification:{label:classification.label,confidence:classification.confidence}}:{})});
     }catch{state='partial';results.push({conversation_id:mapping.replynest_resource_id,reason:'read_failed',target_member_id:null,expected_assignee_id:null});}
    }
    if(scanLimited&&state==='completed'){state='partial';code='scan_limit';}
    if(!await authorize()){state='cancelled';code='authorization_revoked';}
   }
  }catch{state='failed';code='plan_validation_failed';}
  const result={mode:'plan_only',executed:false,planned_count:planned,scanned,scan_limit:100,scan_limited:scanLimited,plan_at:at,code,items:results};
  const finish=await pool.connect();
  try{
   await finish.query('BEGIN');
   await finish.query("SET LOCAL statement_timeout='3s'");
   await finish.query("SET LOCAL lock_timeout='500ms'");
   const saved=await finishAutomationPlan(finish,run,state,result);
   if(saved)await finish.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id) VALUES($1,'system','automation-planner','automation.plan_completed','automation_rule',$2,$3::jsonb,$4)`,[run.tenant_id,run.rule_id,JSON.stringify({run_id:run.run_id,state,planned_count:planned,executed:false}),run.run_id]);
   await finish.query('COMMIT');
   if(saved)recordPlanOutcome(state,code,results.some(r=>r.reason==='read_failed'));
  }catch{await finish.query('ROLLBACK');throw new Error('plan_result_failed');}finally{finish.release();}
}

let draining=false;
export async function processAutomationPlanQueue(transport:PlanTransport=live){
 if(draining||!enabled())return;draining=true;
 const deadline=Date.now()+5000;let claimed=0,completed=0;
 try{
  const outcomes=await Promise.allSettled(Array.from({length:PLAN_CONCURRENCY},async()=>{
   while(enabled()&&Date.now()<deadline&&claimed<200){
    claimed++; // Reserve a bounded attempt before yielding to another lane.
    const run:ClaimedPlan|undefined=await serializeAutomationClaim(async()=>{
     const c=await pool.connect();try{return await claimAutomationPlan(c);}finally{c.release();}
    });
    if(!run)return;
    await planOne(run,transport);
    completed++;
   }
  }));
  if(outcomes.some(o=>o.status==='rejected'))throw Error('plan_drain_failed');
  return {retrySoon:completed>0,completed};
 }finally{draining=false;}
}

// Compatibility for isolated tests and one-shot callers. Gateway ticks enqueue
// independently, so an occupied planner does not prevent discovering due rules.
export async function processAutomationPlans(transport:PlanTransport=live){
 await enqueueAutomationPlans();await processAutomationPlanQueue(transport);
}
