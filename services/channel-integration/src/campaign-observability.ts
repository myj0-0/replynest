import {searchAdminTenants} from './admin-tenant-search.js';
import {adminSummary} from './admin-summary-cache.js';
import { pool } from "./database.js";
import { emitNotification } from "./notification-gateway.js";
import {tenantMassCampaignMetrics} from './mass-campaign-metrics.js';
import {massHealthMetricsSql,massHealthReasons,massMonitorThresholds,monitorInteger,type MassHealthMetrics} from './campaign-monitor-core.js';

type MetricRow = {
  campaigns_24h: number; active_campaigns: number; delivery_total_24h: number;
  delivered_24h: number; suppressed_24h: number; dead_24h: number;
  pending: number; oldest_pending_seconds: number; failure_rate_percent: number;
};

const metricSql = (tenantFilter: boolean) => `WITH c_stats AS (
 SELECT COUNT(*) FILTER(WHERE created_at>=NOW()-INTERVAL '24 hours')::int AS campaigns_24h,
 COUNT(*) FILTER(WHERE status IN ('scheduled','running','paused'))::int AS active_campaigns
 FROM message_campaigns WHERE (created_at>=NOW()-INTERVAL '24 hours' OR status IN ('scheduled','running','paused'))
 ${tenantFilter?'AND tenant_id=$1':''}
), d_stats AS (
 SELECT COUNT(*) FILTER(WHERE created_at>=NOW()-INTERVAL '24 hours')::int AS delivery_total_24h,
 COUNT(*) FILTER(WHERE status='delivered' AND updated_at>=NOW()-INTERVAL '24 hours')::int AS delivered_24h,
 COUNT(*) FILTER(WHERE status='suppressed' AND updated_at>=NOW()-INTERVAL '24 hours')::int AS suppressed_24h,
 COUNT(*) FILTER(WHERE status='dead' AND updated_at>=NOW()-INTERVAL '24 hours')::int AS dead_24h,
 COUNT(*) FILTER(WHERE status IN ('queued','retry_pending','processing'))::int AS pending,
 COALESCE(EXTRACT(EPOCH FROM (NOW()-MIN(created_at) FILTER(WHERE status IN ('queued','retry_pending','processing')))),0)::int AS oldest_pending_seconds
 FROM message_campaign_deliveries
 WHERE (created_at>=NOW()-INTERVAL '24 hours' OR updated_at>=NOW()-INTERVAL '24 hours' OR status IN ('queued','retry_pending','processing'))
 ${tenantFilter?'AND tenant_id=$1':''}
)
 SELECT c_stats.*,d_stats.*,CASE WHEN delivered_24h+dead_24h=0 THEN 0
 ELSE ROUND(100.0*dead_24h/(delivered_24h+dead_24h),2)::float END AS failure_rate_percent
 FROM c_stats CROSS JOIN d_stats`;

export async function tenantCampaignMetrics(tenantId: string) {
  const [result,mass]=await Promise.all([pool.query<MetricRow>(metricSql(true),[tenantId]),tenantMassCampaignMetrics(pool,tenantId)]);
  return { window: "24h", execution_enabled: process.env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED === "true", ...result.rows[0],
    mass,units:{mass:'provider_batch',legacy:'synthetic_recipient'},
    mass_windows:{queue:'current',terminal:'24h'} };
}

export async function platformCampaignDiagnostics(params=new URLSearchParams()) {
 const selected=await searchAdminTenants(params.get('q')??'',params.get('page'));
 const summary=await globalCampaignSummary();
 const tenants=await pool.query(`SELECT t.tenant_id,t.name,m.* FROM tenants t
 CROSS JOIN LATERAL (${metricSql(true).replaceAll('$1','t.tenant_id')}) m
 WHERE t.tenant_id=ANY($1::text[]) ORDER BY t.name,t.tenant_id`,[selected.items.map(t=>t.tenant_id)]);
 const mass=await pool.query(`SELECT t.tenant_id,m.* FROM tenants t CROSS JOIN LATERAL
 (${massHealthMetricsSql(true).replaceAll('$1','t.tenant_id')}) m
 WHERE t.tenant_id=ANY($1::text[])`,[selected.items.map(t=>t.tenant_id)]);
 const scan=(await pool.query("SELECT last_checked_at FROM campaign_health_scan_cursor WHERE scan_key='campaign-health-v1'")).rows[0];
 return {window:'24h',execution_enabled:process.env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED==='true',
 monitor_enabled:process.env.MESSAGE_CAMPAIGN_MONITOR_ENABLED==='true',thresholds:campaignThresholds(),
 mass_monitor_enabled:process.env.MASS_CAMPAIGN_MONITOR_ENABLED==='true',mass_thresholds:massMonitorThresholds(),
 mass_summary:summary.mass,monitor_batch_size:monitorInteger(process.env.MESSAGE_CAMPAIGN_MONITOR_BATCH_SIZE,100,1,200),
 last_scan_at:scan?.last_checked_at??null,
 summary:summary.legacy,tenants:tenants.rows.map(t=>({...t,mass:mass.rows.find(m=>m.tenant_id===t.tenant_id)})),page:selected.page,has_more:selected.has_more};
}

async function globalCampaignSummary(){
 return adminSummary('campaigns',async()=>{
  const [legacy,mass]=await Promise.all([pool.query<MetricRow>(metricSql(false)),pool.query<MassHealthMetrics>(massHealthMetricsSql(false))]);
  return {legacy:legacy.rows[0],mass:mass.rows[0]};
 });
}

export function campaignThresholds() {
  return {
    backlog: monitorInteger(process.env.MESSAGE_CAMPAIGN_BACKLOG_WARN,100),
    oldest_seconds: monitorInteger(process.env.MESSAGE_CAMPAIGN_OLDEST_WARN_SECONDS,900,60),
    failure_rate_percent: monitorInteger(process.env.MESSAGE_CAMPAIGN_FAILURE_RATE_WARN_PERCENT,10,1,100),
    failure_sample_minimum: monitorInteger(process.env.MESSAGE_CAMPAIGN_FAILURE_SAMPLE_MINIMUM,10)
  };
}

export async function campaignDeliveryHealth() {
  const {legacy:metrics,mass}=await globalCampaignSummary();
  const thresholds = campaignThresholds();
  const terminal = metrics.delivered_24h + metrics.dead_24h;
  const breached = metrics.pending >= thresholds.backlog || metrics.oldest_pending_seconds >= thresholds.oldest_seconds ||
    (terminal >= thresholds.failure_sample_minimum && metrics.failure_rate_percent >= thresholds.failure_rate_percent);
  const enabled = process.env.MESSAGE_CAMPAIGN_MONITOR_ENABLED === "true";
  const massEnabled=process.env.MASS_CAMPAIGN_MONITOR_ENABLED==='true';
  const massThresholds=massMonitorThresholds(),massReasons=massHealthReasons(mass,massThresholds);
  const lastScan=(await pool.query("SELECT last_checked_at FROM campaign_health_scan_cursor WHERE scan_key='campaign-health-v1'")).rows[0]?.last_checked_at??null;
  const interval=monitorInteger(process.env.MESSAGE_CAMPAIGN_MONITOR_POLL_MS,60_000,5000,3_600_000);
  const stale=!lastScan||Date.now()-new Date(lastScan).getTime()>interval*3;
  return { status: !enabled&&!massEnabled ? "monitor_disabled" : stale||(enabled&&breached)||(massEnabled&&massReasons.length>0) ? "degraded" : "operational", monitor_enabled: enabled,
    execution_enabled: process.env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED === "true", pending: metrics.pending,
    oldest_pending_seconds: metrics.oldest_pending_seconds, dead_24h: metrics.dead_24h,
    failure_rate_percent: metrics.failure_rate_percent, thresholds,
    mass_monitor_enabled:massEnabled,mass, mass_thresholds:massThresholds,last_scan_at:lastScan,
    scan_stale:(enabled||massEnabled)&&stale,units:{mass:'provider_batch',legacy:'synthetic_recipient'} };
}

export async function scanCampaignDeliveryHealth() {
  const legacyEnabled=process.env.MESSAGE_CAMPAIGN_MONITOR_ENABLED==='true',massEnabled=process.env.MASS_CAMPAIGN_MONITOR_ENABLED==='true';
  if(!legacyEnabled&&!massEnabled)return {scanned:0,emitted:0};
  const thresholds = campaignThresholds();
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   // 跨进程单轮独占；游标持久化，重启不会总从第一批企业开始。
   if(!(await client.query("SELECT pg_try_advisory_xact_lock(hashtext('campaign-health-v1')) locked")).rows[0].locked){await client.query('ROLLBACK');return {scanned:0,emitted:0,busy:true};}
   await client.query('SET LOCAL statement_timeout=5000');
   const cursor=(await client.query("SELECT tenant_cursor FROM campaign_health_scan_cursor WHERE scan_key='campaign-health-v1' FOR UPDATE")).rows[0];
   if(!cursor)throw Error('campaign_monitor_schema_required');
   const limit=monitorInteger(process.env.MESSAGE_CAMPAIGN_MONITOR_BATCH_SIZE,100,1,200);
   const selected=(await client.query("SELECT tenant_id FROM tenants WHERE tenant_id>$1 AND status IN('active','test') ORDER BY tenant_id LIMIT $2",[cursor.tenant_cursor,limit+1])).rows;
   const tenants=selected.slice(0,limit);let emitted=0;
   for(const tenant of tenants){
    if(legacyEnabled){
     const row=(await client.query<MetricRow>(metricSql(true),[tenant.tenant_id])).rows[0];
    const terminal = row.delivered_24h + row.dead_24h;
    const reasons = [row.pending >= thresholds.backlog && "队列积压", row.oldest_pending_seconds >= thresholds.oldest_seconds && "最长等待超限",
      terminal >= thresholds.failure_sample_minimum && row.failure_rate_percent >= thresholds.failure_rate_percent && "失败率超限"].filter(Boolean);
    if(reasons.length){
    await emitNotification({ tenant_id: tenant.tenant_id, event_type: "campaign.delivery_health", severity: "warning",
      title: "消息活动投递需要检查", summary: `${reasons.join("、")}；请在消息与活动页查看脱敏诊断。`,
      dedupe_key: `campaign-health:${new Date().toISOString().slice(0,13)}`, resource_type: "message_campaign_queue",
      actor_type: "system", actor_id: "campaign-health-monitor", requires_action: true, delivery_mode: "in_app_only" });
    emitted++;
    }
    }
    if(massEnabled){
     const m=(await client.query<MassHealthMetrics>(massHealthMetricsSql(true),[tenant.tenant_id])).rows[0];
     const reasons=massHealthReasons(m);
     if(reasons.length){
      await emitNotification({tenant_id:tenant.tenant_id,event_type:'campaign.mass_health',severity:'warning',
       title:'公众号群发批次需要检查',summary:`${reasons.join('、')}；到期待处理 ${m.ready_batches} 批，等待平台结果 ${m.awaiting_receipt_batches} 批，结果不确定 ${m.uncertain_batches} 批。请在消息与活动中核查，不要重复发送结果不明的批次。`,
       dedupe_key:`campaign-mass-health:${new Date().toISOString().slice(0,13)}`,resource_type:'message_campaign_mass_queue',
       actor_type:'system',actor_id:'campaign-health-monitor',requires_action:true,delivery_mode:'in_app_only'});
      emitted++;
     }
    }
  }
   await client.query("UPDATE campaign_health_scan_cursor SET tenant_cursor=$1,last_checked_at=NOW() WHERE scan_key='campaign-health-v1'",[selected.length>limit?tenants.at(-1)!.tenant_id:'']);
   await client.query('COMMIT');return {scanned:tenants.length,emitted,has_more:selected.length>limit};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
