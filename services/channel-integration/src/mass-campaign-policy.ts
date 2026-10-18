import type {PoolClient} from 'pg';
import type {MassLease} from './mass-campaign-store.js';
import {isCampaignQuietTime,nextCampaignAllowedAt,matchesCampaignCancelCondition} from './message-campaign-core.js';
import type {MassEligibility} from './mass-campaign-runtime.js';
type Db=Pick<PoolClient,'query'>;
type PlanReader=(tenantId:string,db:Db)=>Promise<string>;
const actualPlan:PlanReader=async(tenantId,db)=>(await (await import('./subscriptions.js')).effectiveEntitlement(tenantId,db)).plan.code;

/** lock=true requires a transaction. This checks platform limits, not remaining WeChat API quota. */
export async function checkMassPolicy(db:Db,lease:MassLease,lock=false,plan:PlanReader=actualPlan):Promise<Exclude<MassEligibility,boolean>>{
 const deny=(reason:string)=>({allowed:false,reason});
 if(lock)await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`mass-channel:${lease.appId}`]);
 const r=await db.query(`SELECT c.*,ch.external_account_id,ch.status channel_status,ch.channel_type,t.status tenant_status,NOW() db_now
  FROM message_campaigns c JOIN channel_connections ch ON ch.connection_id=c.channel_connection_id AND ch.tenant_id=c.tenant_id
  JOIN tenants t ON t.tenant_id=c.tenant_id WHERE c.tenant_id=$1 AND c.campaign_id=$2 AND ch.connection_id=$3
  ${lock?'FOR UPDATE OF c,ch,t':''}`,[lease.tenantId,lease.campaignId,lease.connectionId]);
 const c=r.rows[0];
 if(!c||!['active','test'].includes(c.tenant_status)||c.channel_status!=='ready'||c.channel!=='wechat_official_account'||c.channel_type!=='wechat_official_account'||c.external_account_id!==lease.appId)return deny('campaign_channel_changed');
 if(!['scheduled','running'].includes(c.status)||!c.approved_at||!c.scheduled_at||new Date(c.scheduled_at)>new Date(c.db_now))return deny('campaign_not_due_or_approved');
 if(c.content!==lease.batch.content)return deny('campaign_content_changed');
 if(lease.appId===process.env.SHARED_WECHAT_APP_ID)return deny('campaign_shared_channel_forbidden');
 const shared=(await db.query("SELECT to_regclass('shared_wechat_accounts') IS NOT NULL present")).rows[0].present;
 if(shared&&(await db.query('SELECT 1 FROM shared_wechat_accounts WHERE app_id=$1',[lease.appId])).rowCount)return deny('campaign_shared_channel_forbidden');
 // A subscription/trial revocation that commits first must be visible before the send barrier.
 // These locks last only until the barrier commits; provider I/O never holds database locks.
 if(lock&&plan===actualPlan){
  await db.query("SELECT subscription_id FROM tenant_subscriptions WHERE tenant_id=$1 AND status IN('active','trialing','past_due') AND (current_period_end IS NULL OR current_period_end>NOW()) ORDER BY subscription_id FOR SHARE",[lease.tenantId]);
  await db.query("SELECT entitlement_id FROM trial_entitlements WHERE tenant_id=$1 AND status='active' AND grace_ends_at>NOW() ORDER BY entitlement_id FOR SHARE",[lease.tenantId]);
 }
 if(await plan(lease.tenantId,db)!=='professional')return deny('campaign_professional_required');
 try{
  if(isCampaignQuietTime(new Date(c.db_now),c.timezone,String(c.quiet_hours_start).slice(0,5),String(c.quiet_hours_end).slice(0,5)))return {allowed:false,reason:'campaign_quiet_hours',retryAt:nextCampaignAllowedAt(new Date(c.db_now),c.timezone,String(c.quiet_hours_start).slice(0,5),String(c.quiet_hours_end).slice(0,5))};
 }catch{return deny('campaign_schedule_invalid');}
 if(!Number.isInteger(c.rate_limit_per_minute)||c.rate_limit_per_minute<1||c.rate_limit_per_minute>100)return deny('campaign_rate_invalid');
 if(lease.batch.openIds.length>c.rate_limit_per_minute)return deny('campaign_rate_invalid');
 // Rate is measured in recipients, not requests. Serialize by AppID at the send barrier.
 const used=await db.query(`SELECT COALESCE(SUM(jsonb_array_length(snapshot->'openIds')),0)::int n FROM message_campaign_mass_batches
  WHERE app_id=$1 AND state IN('submitting','submitted','uncertain','succeeded','failed','deleted') AND locked_at>NOW()-INTERVAL '1 minute'`,[lease.appId]);
 if(Number(used.rows[0].n)+lease.batch.openIds.length>c.rate_limit_per_minute)return {allowed:false,reason:'campaign_rate_limited',retryAt:new Date(new Date(c.db_now).getTime()+61_000)};
 const targets=await db.query(`SELECT i.identity_id,i.external_user_id,i.sync_status,cu.attributes
  FROM message_campaign_recipients r JOIN channel_identities i ON i.tenant_id=r.tenant_id AND i.identity_id=r.identity_id AND i.customer_id=r.customer_id
  JOIN customers cu ON cu.tenant_id=r.tenant_id AND cu.customer_id=r.customer_id
  WHERE r.tenant_id=$1 AND r.campaign_id=$2 AND r.eligible AND i.channel_connection_id=$3
   AND i.channel='wechat_official_account' AND i.external_user_id=ANY($4::text[]) ORDER BY i.identity_id LIMIT 10001 ${lock?'FOR UPDATE OF i,cu':''}`,
  [lease.tenantId,lease.campaignId,lease.connectionId,lease.batch.openIds]);
 if(targets.rows.length!==lease.batch.openIds.length||new Set(targets.rows.map(v=>v.external_user_id)).size!==lease.batch.openIds.length)return deny('campaign_recipient_changed');
 // Match the advisory lock used by recordMarketingConsent; sorted IDs avoid lock-order cycles.
 if(lock)for(const i of targets.rows)await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`marketing-consent:${lease.tenantId}:${i.identity_id}`]);
 const consents=await db.query(`SELECT DISTINCT ON(identity_id) identity_id,status FROM marketing_consent_events
  WHERE tenant_id=$1 AND purpose='marketing' AND identity_id=ANY($2::uuid[])
  ORDER BY identity_id,created_at DESC,consent_event_id DESC`,[lease.tenantId,targets.rows.map(v=>v.identity_id)]);
 const granted=new Set(consents.rows.filter(v=>v.status==='granted').map(v=>v.identity_id));
 for(const i of targets.rows){
  if(i.sync_status!=='synced'||!granted.has(i.identity_id))return deny('campaign_consent_missing_or_withdrawn');
  try{if(matchesCampaignCancelCondition(i.attributes,c.cancel_condition))return deny('campaign_cancel_condition');}
  catch{return deny('campaign_cancel_condition_invalid');}
 }
 return {allowed:true,reason:'eligible'};
}
