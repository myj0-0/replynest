export const insightConsentVersion='customer-insights-v1';
export const insightTopicLabels={consultation:'售前咨询',onboarding:'注册与上手',usage:'使用问题',shipping:'发货与配送',refund:'退款与售后',billing:'套餐与费用',complaint:'投诉与反馈',integration:'渠道与对接',other:'其他'} as const;
export const insightProfileLabels={product_info:'了解产品',setup_help:'上手帮助',integration_help:'渠道对接',shipping_speed:'发货时效',after_sales:'售后帮助',pricing_cost:'费用关注',
 concise_reply:'简洁回复',detailed_reply:'详细说明',evening_contact:'晚间联系',written_contact:'文字联系',phone_contact:'电话联系',human_support:'人工协助',other_explicit_need:'其他明确需求'} as const;
export const insightPreferenceCategories=new Set(['concise_reply','detailed_reply','evening_contact','written_contact','phone_contact','human_support']);
export type InsightsSettings={enabled:boolean;grant_active:boolean;revision:number;daily_budget_points:string;consent_version:string;
 budget_day:string;charged_points:string;held_points:string};
export type InsightsTopics={total:number;topics:Array<{topic:keyof typeof insightTopicLabels;count:number;percent:number}>};
export type InsightsProfiles={total:number;classified:number;unclassified:number;categories:Array<{category:keyof typeof insightProfileLabels;count:number;percent:number}>};
export type InsightsProfile={can_edit:boolean;profile:null|{revision:number;suppressed:boolean;long_term:string[];current_issue:string|null}};
export const insightJobStates={pending:'等待处理',leased:'正在核验',calling:'正在生成',saved:'备注已保存',skipped:'已跳过',revoked:'已停止',budget_exhausted:'预算不足',rejected:'结果未采用',uncertain:'执行结果待核对'} as const;
export type InsightsBilling={records:Array<{job_id:string;created_at:string;job_state:keyof typeof insightJobStates;budget_state:'held'|'calling'|'known'|'not_called'|'unknown'|null;
 reserved_points:string;budget_hold_points:string;charged_points:string|null;points_state:'unreserved'|'reserved'|'charged'|'not_charged'|'unknown';can_reconcile:boolean}>;next_before:string|null};
export const insightMessages:Record<string,string>={insights_disabled:'客户 AI 备注尚未开放。',unauthorized:'请重新登录。',invalid_origin:'请求来源校验失败。',
 insights_identity_required:'请使用当前企业的有效登录账号操作。',insights_admin_required:'请使用本企业管理员账号授权或调整预算。',
 workspace_changed:'当前企业已切换，请重新打开页面。',insights_revision_conflict:'配置已变化，请刷新核实后再操作。',
 insights_consent_required:'请阅读并单独确认客户 AI 备注用途。',insights_budget_invalid:'每日预算须为 0.001 至 10,000 AI 点数，最多六位小数。',
 invalid_payload:'请求参数不正确。',body_too_large:'请求内容过长。',body_timeout:'请求读取超时。',method_not_allowed:'不支持此操作。',
 insights_result_uncertain:'操作结果暂时无法确认，请刷新核实，不要重复提交。',
 insights_customer_unavailable:'当前客户或会话不可用，请刷新工作台。',insights_edit_forbidden:'仅当前负责客服、主管或管理员可修改。',
 insights_permission_unavailable:'暂时无法核对当前会话权限，请稍后重试。',insights_assignment_verification_required:'请先核对当前会话分配。',
 insights_correction_invalid:'备注内容格式不正确或过长。',insights_summary_missing:'当前会话尚无总结，暂时不能纠正。',
 insights_cursor_invalid:'账务分页位置无效，请重新加载第一页。',insights_points_not_settled:'费用尚未取得已结算账本凭证；预占继续保留，请联系客服核对，不要重试模型。',
 insights_settlement_conflict:'费用记录不一致，请联系客服核对。'};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
function invalid():never{throw Error('insights_result_uncertain');}
export function parseInsightsProfile(v:unknown):InsightsProfile{
 if(!object(v)||typeof v.can_edit!=='boolean')invalid();
 if(v.profile===null)return {can_edit:v.can_edit,profile:null};
 const p=v.profile;if(!object(p)||!integer(p.revision)||typeof p.suppressed!=='boolean'||!Array.isArray(p.long_term)||p.long_term.length>12||
  p.long_term.some(s=>typeof s!=='string'||s.length>200)||!(p.current_issue===null||typeof p.current_issue==='string'&&p.current_issue.length<=600)||
  p.suppressed&&(p.long_term.length>0||p.current_issue!==null))invalid();
 return {can_edit:v.can_edit,profile:{revision:p.revision,suppressed:p.suppressed,long_term:p.long_term as string[],current_issue:p.current_issue as string|null}};
}
export function parseInsightsSettings(v:unknown):InsightsSettings{
 if(!object(v)||typeof v.enabled!=='boolean'||typeof v.grant_active!=='boolean'||v.grant_active&&!v.enabled||!integer(v.revision)||v.consent_version!==insightConsentVersion||
  typeof v.budget_day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v.budget_day))invalid();
 const point=(p:unknown)=>typeof p==='string'&&/^\d{1,12}\.\d{6}$/.test(p);
 if(!point(v.daily_budget_points)||Number(v.daily_budget_points)<0.001||Number(v.daily_budget_points)>10000||!point(v.charged_points)||!point(v.held_points))invalid();
 return {enabled:v.enabled,grant_active:v.grant_active,revision:v.revision,daily_budget_points:v.daily_budget_points as string,
  consent_version:insightConsentVersion,budget_day:v.budget_day,charged_points:v.charged_points as string,held_points:v.held_points as string};
}
export function parseInsightsTopics(v:unknown):InsightsTopics{
 if(!object(v)||!integer(v.total)||!Array.isArray(v.topics)||v.topics.length!==9)invalid();
 const seen=new Set<string>();let sum=0;
 const topics=v.topics.map(t=>{
  if(!object(t)||typeof t.topic!=='string'||!Object.hasOwn(insightTopicLabels,t.topic)||seen.has(t.topic)||!integer(t.count)||
   typeof t.percent!=='number'||!Number.isFinite(t.percent)||t.percent<0||t.percent>100||Math.abs(t.percent-(v.total as number?t.count/(v.total as number)*100:0))>0.000001)invalid();
  seen.add(t.topic);sum+=t.count;return {topic:t.topic as keyof typeof insightTopicLabels,count:t.count,percent:t.percent};
 });
 if(sum!==v.total)invalid();return {total:v.total,topics};
}
export function parseInsightsProfiles(v:unknown):InsightsProfiles{
 if(!object(v)||!integer(v.total)||!integer(v.classified)||!integer(v.unclassified)||v.classified+v.unclassified!==v.total||
  !Array.isArray(v.categories)||v.categories.length!==Object.keys(insightProfileLabels).length)invalid();
 const seen=new Set<string>();let sum=0;
 const categories=v.categories.map(c=>{
  if(!object(c)||typeof c.category!=='string'||!Object.hasOwn(insightProfileLabels,c.category)||seen.has(c.category)||!integer(c.count)||c.count>(v.classified as number)||
   typeof c.percent!=='number'||!Number.isFinite(c.percent)||c.percent<0||c.percent>100||Math.abs(c.percent-(v.total as number?c.count/(v.total as number)*100:0))>0.000001)invalid();
  seen.add(c.category);sum+=c.count;return {category:c.category as keyof typeof insightProfileLabels,count:c.count,percent:c.percent};
 });
 if(sum<(v.classified as number))invalid();return {total:v.total,classified:v.classified,unclassified:v.unclassified,categories};
}
export function parseInsightsBilling(v:unknown):InsightsBilling{
 const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(x);
 const point=(x:unknown):x is string=>typeof x==='string'&&/^\d{1,5}\.\d{6}$/.test(x)&&Number(x)<=10000;
 if(!object(v)||!Array.isArray(v.records)||v.records.length>10||!(v.next_before===null||uuid(v.next_before)))invalid();
 const seen=new Set<string>();
 const records=v.records.map(r=>{
  if(!object(r)||!uuid(r.job_id)||seen.has(r.job_id)||typeof r.created_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(r.created_at)||!Number.isFinite(Date.parse(r.created_at))||
   typeof r.job_state!=='string'||!Object.hasOwn(insightJobStates,r.job_state)||!(r.budget_state===null||['held','calling','known','not_called','unknown'].includes(r.budget_state as string))||
   !point(r.reserved_points)||!point(r.budget_hold_points)||!(r.charged_points===null||point(r.charged_points))||typeof r.points_state!=='string'||!['unreserved','reserved','charged','not_charged','unknown'].includes(r.points_state)||
   typeof r.can_reconcile!=='boolean'||r.can_reconcile&&!(r.points_state==='charged'&&['calling','unknown'].includes(r.budget_state as string))||
   (r.charged_points===null)!==!['charged','not_charged'].includes(r.points_state)||r.charged_points!==null&&Number(r.charged_points)>Number(r.reserved_points)||
   Number(r.budget_hold_points)!==(['held','calling','unknown'].includes(r.budget_state as string)?Number(r.reserved_points):0))invalid();
  seen.add(r.job_id);return {job_id:r.job_id,created_at:r.created_at,job_state:r.job_state as keyof typeof insightJobStates,budget_state:r.budget_state as InsightsBilling['records'][number]['budget_state'],
   reserved_points:r.reserved_points,budget_hold_points:r.budget_hold_points,charged_points:r.charged_points as string|null,points_state:r.points_state as InsightsBilling['records'][number]['points_state'],can_reconcile:r.can_reconcile};
 });
 if(v.next_before!==null&&(records.length!==10||records.at(-1)?.job_id!==v.next_before))invalid();
 return {records,next_before:v.next_before};
}
