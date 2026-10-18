import { validateAutomationPreview, simulateAutomation, type AutomationPreview } from './automation-preview.js';
import { ExtensionError } from './extension-core.js';

export const planPermissions=['conversation.read_for_plan','automation.schedule_plan'] as const;
export const schedulePermissions=[...planPermissions,'conversation.assign_scheduled'] as const;
export const messageEventsEnabled=()=>process.env.STUDIO_MESSAGE_EVENTS_ENABLED==='true';
export function rulePermissions(d:AutomationPreview,scheduled=false){return [...(scheduled?schedulePermissions:planPermissions),...(d.trigger==='message_received'?['conversation.message_event']:[]),...(d.keywords.length?['conversation.keyword_routing']:[]),...(d.semantic?['conversation.semantic_routing','ai.points.consume']:[])];}
export const scheduledAssignmentEnabled=()=>process.env.AUTOMATION_SCHEDULE_EXECUTION_ENABLED==='true';
export const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateRule(raw:unknown):AutomationPreview {
 const d=validateAutomationPreview(raw);
 if(ruleMembers(d).some(id=>!uuidPattern.test(id)))throw new ExtensionError('rule_member_binding_required');
 return d;
}
export function ruleMembers(d:AutomationPreview):string[]{return [...new Set(d.trigger==='weekly'?d.slots.map(s=>s.assignee_ref):[d.assignee_ref])];}
export function nextRuleRun(d:AutomationPreview,now:Date):string|null {
 return simulateAutomation(d,[],now.toISOString()).next_runs[0]?.at??null;
}
export function ruleTarget(d:AutomationPreview,at:Date):string|null {
 if(d.trigger!=='weekly')return d.assignee_ref;
 const local=new Date(at.getTime()+8*3600000);
 return d.slots.find(s=>s.weekdays.includes(local.getUTCDay()||7)&&s.time===local.toISOString().slice(11,16))?.assignee_ref??null;
}
