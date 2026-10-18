export function monitorInteger(value:string|undefined,fallback:number,min=1,max=1_000_000){
 const n=Number(value);return Number.isFinite(n)&&Number.isInteger(n)&&n>=min?Math.min(max,n):fallback;
}
export function massMonitorThresholds(env:NodeJS.ProcessEnv=process.env){
 return {backlog:monitorInteger(env.MASS_CAMPAIGN_BACKLOG_WARN,100),
  oldest_seconds:monitorInteger(env.MASS_CAMPAIGN_OLDEST_WARN_SECONDS,900,60),
  receipt_seconds:monitorInteger(env.MASS_CAMPAIGN_RECEIPT_WARN_SECONDS,900,60),
  uncertain:monitorInteger(env.MASS_CAMPAIGN_UNCERTAIN_WARN,1),
  failure_rate_percent:monitorInteger(env.MASS_CAMPAIGN_FAILURE_RATE_WARN_PERCENT,10,1,100),
  failure_sample_minimum:monitorInteger(env.MASS_CAMPAIGN_FAILURE_SAMPLE_MINIMUM,10)};
}
export type MassHealthMetrics={pending_batches:number;paused_batches:number;awaiting_receipt_batches:number;uncertain_batches:number;
 succeeded_batches_24h:number;unsuccessful_batches_24h:number;ready_batches:number;oldest_ready_seconds:number;
 oldest_receipt_seconds:number;failure_rate_percent:number};
export function massHealthReasons(m:MassHealthMetrics,t=massMonitorThresholds()){
 return [m.ready_batches>=t.backlog&&'到期待处理批次积压',
  m.ready_batches>0&&m.oldest_ready_seconds>=t.oldest_seconds&&'到期批次等待超时',
  m.awaiting_receipt_batches>0&&m.oldest_receipt_seconds>=t.receipt_seconds&&'等待微信批次结果超时',
  m.uncertain_batches>=t.uncertain&&'存在结果不确定批次，请勿重复发送',
  m.succeeded_batches_24h+m.unsuccessful_batches_24h>=t.failure_sample_minimum&&m.failure_rate_percent>=t.failure_rate_percent&&'批次未成功比例超限'
 ].filter((value):value is string=>typeof value==='string');
}
/** Aggregate only live batches and recent terminal outcomes; never read snapshot/content. */
export const massHealthMetricsSql=(tenant:boolean)=>`WITH live AS (
 SELECT COUNT(*) FILTER(WHERE b.state IN('queued','preparing','submitting') AND c.status IN('scheduled','running'))::int pending_batches,
 COUNT(*) FILTER(WHERE b.state IN('queued','preparing','submitting') AND c.status='paused')::int paused_batches,
 COUNT(*) FILTER(WHERE b.state='submitted')::int awaiting_receipt_batches,
 COUNT(*) FILTER(WHERE b.state='uncertain')::int uncertain_batches,
 COUNT(*) FILTER(WHERE b.state IN('queued','preparing','submitting') AND c.status IN('scheduled','running')
  AND b.available_at<=NOW() AND c.scheduled_at<=NOW())::int ready_batches,
 COALESCE(MAX(EXTRACT(EPOCH FROM NOW()-GREATEST(b.available_at,c.scheduled_at))) FILTER(
  WHERE b.state IN('queued','preparing','submitting') AND c.status IN('scheduled','running')
  AND b.available_at<=NOW() AND c.scheduled_at<=NOW()),0)::int oldest_ready_seconds,
 COALESCE(MAX(EXTRACT(EPOCH FROM NOW()-COALESCE(b.locked_at,b.created_at))) FILTER(WHERE b.state='submitted'),0)::int oldest_receipt_seconds
 FROM message_campaign_mass_batches b JOIN message_campaigns c ON c.tenant_id=b.tenant_id AND c.campaign_id=b.campaign_id
 WHERE b.state IN('queued','preparing','submitting','submitted','uncertain') ${tenant?'AND b.tenant_id=$1':''}
), recent AS (
 SELECT COUNT(*) FILTER(WHERE state='succeeded')::int succeeded_batches_24h,
 COUNT(*) FILTER(WHERE state IN('blocked','failed','deleted'))::int unsuccessful_batches_24h
 FROM message_campaign_mass_batches WHERE state IN('succeeded','blocked','failed','deleted')
 AND updated_at>=NOW()-INTERVAL '24 hours' ${tenant?'AND tenant_id=$1':''}
)
SELECT live.*,recent.*,CASE WHEN succeeded_batches_24h+unsuccessful_batches_24h=0 THEN 0
 ELSE ROUND(100.0*unsuccessful_batches_24h/(succeeded_batches_24h+unsuccessful_batches_24h),2)::float END failure_rate_percent
FROM live CROSS JOIN recent`;

export const campaignMonitorSchema=`
 CREATE TABLE IF NOT EXISTS campaign_health_scan_cursor(
  scan_key TEXT PRIMARY KEY,tenant_cursor TEXT NOT NULL DEFAULT '',last_checked_at TIMESTAMPTZ
 );
 INSERT INTO campaign_health_scan_cursor(scan_key) VALUES('campaign-health-v1') ON CONFLICT DO NOTHING;
 CREATE INDEX IF NOT EXISTS campaign_mass_global_live_metrics ON message_campaign_mass_batches(state,created_at)
  WHERE state IN('queued','preparing','submitting','submitted','uncertain');
 CREATE INDEX IF NOT EXISTS campaign_mass_global_recent_metrics ON message_campaign_mass_batches(updated_at)
  WHERE state IN('succeeded','blocked','failed','deleted');
`;
