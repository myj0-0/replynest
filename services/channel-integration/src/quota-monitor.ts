import{pool}from"./database.js";import{emitNotification}from"./notification-gateway.js";import{crossedQuotaThresholds,quotaPercent,type QuotaMetric,type QuotaValue}from"./quota-core.js";import{usageOverview}from"./subscriptions.js";
import {runQuotaScan} from './quota-scan.js';
import type {PoolClient} from 'pg';
import {enqueueAiLowMail} from './ai-low-mail.js';
const labels:Record<QuotaMetric,string>={seats:"坐席",channels:"渠道",customers:"客户",ai_actions_monthly:"本月 AI 建议",knowledge_bytes:"知识库容量"};
function values(overview:Awaited<ReturnType<typeof usageOverview>>):QuotaValue[]{const subscriptionKey=String(overview.subscription.subscription_id??`${overview.plan.code}-fallback`);return[
  {metric:"seats",used:Number(overview.usage.active_seats),limit:overview.entitlements.seat_limit,periodKey:subscriptionKey},
  {metric:"channels",used:Number(overview.usage.channels),limit:overview.entitlements.channel_limit,periodKey:subscriptionKey},
  {metric:"customers",used:Number(overview.usage.customers),limit:overview.entitlements.customer_limit,periodKey:subscriptionKey},
  {metric:"ai_actions_monthly",used:Number(overview.usage.ai_actions_monthly),limit:overview.entitlements.ai_actions_monthly,periodKey:new Date(overview.usage.period_start).toISOString().slice(0,10)},
  {metric:"knowledge_bytes",used:Number(overview.usage.knowledge_bytes),limit:overview.entitlements.knowledge_bytes,periodKey:subscriptionKey}
]}
export async function scanQuotaWarnings(){
 return runQuotaScan(enqueueTenantQuotaWarnings,emitQuotaWarnings);
}
export async function enqueueTenantQuotaWarnings(tenant:string,db:PoolClient){
  let created=0;
  const overview=await usageOverview(tenant,db);
  for(const item of values(overview))for(const threshold of crossedQuotaThresholds(item.used,item.limit)){
   const inserted=await db.query(`INSERT INTO quota_notification_jobs(tenant_id,metric,period_key,threshold,used_units,limit_units) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,metric,period_key,threshold) DO NOTHING RETURNING quota_job_id`,[tenant,item.metric,item.periodKey,threshold,item.used,item.limit]);created+=inserted.rowCount??0;
  }
  return created+await enqueueAiLowMail(tenant,db);
}
async function emitQuotaWarnings(){let emitted=0;
  const jobs=await pool.query<{quota_job_id:string;tenant_id:string;metric:QuotaMetric;period_key:string;threshold:80|100;used_units:string;limit_units:string}>(`SELECT quota_job_id,tenant_id,metric,period_key,threshold,used_units,limit_units FROM quota_notification_jobs WHERE status='pending' AND next_attempt_at<=NOW() ORDER BY created_at LIMIT 50`);
  for(const job of jobs.rows){try{const percent=quotaPercent(Number(job.used_units),Number(job.limit_units))??job.threshold;const severity=job.threshold===100?"critical":"warning";const result=await emitNotification({tenant_id:job.tenant_id,event_type:`quota.${job.threshold}`,severity,title:`${labels[job.metric]}额度${job.threshold===100?"已用尽":"即将用尽"}`,summary:`${labels[job.metric]}当前已使用 ${percent}%，请检查用量或联系管理员调整套餐。`,resource_type:"subscription_quota",resource_id:job.metric,dedupe_key:`quota:${job.metric}:${job.period_key}:${job.threshold}`.replace(/[^A-Za-z0-9:_.-]/g,"-"),metadata:{metric:job.metric,used:Number(job.used_units),limit:Number(job.limit_units),threshold:job.threshold},requires_action:true,webhook_scope:"system"});await pool.query(`UPDATE quota_notification_jobs SET status='emitted',notification_id=$2,attempt_count=attempt_count+1,updated_at=NOW() WHERE quota_job_id=$1`,[job.quota_job_id,result.notification_id]);if(job.threshold===100)await pool.query(`UPDATE notification_events SET status='resolved',resolved_at=NOW(),updated_at=NOW() WHERE status IN ('open','acknowledged') AND notification_id IN (SELECT notification_id FROM quota_notification_jobs WHERE tenant_id=$1 AND metric=$2 AND period_key=$3 AND threshold=80 AND status='emitted')`,[job.tenant_id,job.metric,job.period_key]);emitted++}catch{await pool.query(`UPDATE quota_notification_jobs SET attempt_count=attempt_count+1,status=CASE WHEN attempt_count+1>=5 THEN 'failed' ELSE 'pending' END,next_attempt_at=NOW()+make_interval(secs=>LEAST(900,30*power(2,attempt_count)::int)),error_code='notification_failed',updated_at=NOW() WHERE quota_job_id=$1`,[job.quota_job_id])}}
  await pool.query(`WITH due AS (SELECT e.notification_id FROM notification_events e JOIN quota_notification_jobs warning_job ON warning_job.notification_id=e.notification_id WHERE warning_job.threshold=80 AND warning_job.status='emitted' AND e.status IN ('open','acknowledged') AND EXISTS(SELECT 1 FROM quota_notification_jobs critical_job WHERE critical_job.tenant_id=warning_job.tenant_id AND critical_job.metric=warning_job.metric AND critical_job.period_key=warning_job.period_key AND critical_job.threshold=100 AND critical_job.status='emitted') ORDER BY e.notification_id LIMIT 100) UPDATE notification_events e SET status='resolved',resolved_at=NOW(),updated_at=NOW() FROM due WHERE due.notification_id=e.notification_id AND e.status IN ('open','acknowledged')`);
  return emitted
}
