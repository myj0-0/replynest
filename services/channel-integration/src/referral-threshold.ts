import {pool} from './database.js';
import {currentGrowthPolicy} from './growth-policy.js';
import {validateReferralRules} from './referral-core.js';
import type {PoolClient} from 'pg';

export async function currentInviterRules(c:Pick<PoolClient,'query'>,campaignRule:unknown){
 const rules=validateReferralRules(campaignRule),policy=await currentGrowthPolicy(c);
 return {...rules,min_lifetime_cash_paid_minor:policy.rules.inviter_min_cash_minor??rules.min_lifetime_cash_paid_minor};
}
export function validateReferralThreshold(raw:Record<string,unknown>){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['cash_minor','expected_version','reason'].includes(k))||
  typeof raw.cash_minor!=='number'||!Number.isSafeInteger(raw.cash_minor)||raw.cash_minor<0||raw.cash_minor>100000000||
  typeof raw.expected_version!=='number'||!Number.isSafeInteger(raw.expected_version)||raw.expected_version<1||raw.expected_version>2147483646||
  typeof raw.reason!=='string'||raw.reason.trim().length<10||raw.reason.trim().length>500)throw Error('invalid_referral_threshold');
 return {cash:raw.cash_minor,version:raw.expected_version,reason:raw.reason.trim()};
}
/** A versioned qualification-only change: no trial campaign republish or money movement. */
export async function publishReferralThreshold(raw:Record<string,unknown>,adminId:string,requestId:string){
 const input=validateReferralThreshold(raw),c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'");
  const admin=(await c.query("SELECT role FROM platform_admin_accounts WHERE admin_id=$1 AND status='active' AND role IN('owner','admin') FOR SHARE",[adminId])).rows[0];
  if(!admin)throw Error('forbidden');
  await c.query("SELECT pg_advisory_xact_lock(hashtext('growth-policy-publish'))");
  const previous=await currentGrowthPolicy(c);if(previous.version!==input.version)throw Error('version_conflict');
  const campaign=(await c.query("SELECT qualification_rule FROM growth_campaigns WHERE campaign_key='tenant-referral-cn' AND campaign_type='referral' AND status='active' AND starts_at<=NOW() AND ends_at>NOW() ORDER BY version DESC LIMIT 1 FOR SHARE")).rows[0];
  if(!campaign)throw Error('referral_campaign_unavailable');
  const before={version:previous.version,cash_minor:previous.rules.inviter_min_cash_minor??validateReferralRules(campaign.qualification_rule).min_lifetime_cash_paid_minor};
  if(before.cash_minor===input.cash){await c.query('COMMIT');return {...before,idempotent_replay:true};}
  const rules={...previous.rules,inviter_min_cash_minor:input.cash};
  const row=(await c.query('INSERT INTO growth_policy_versions(version,rules,reason,created_by) VALUES($1,$2,$3,$4) RETURNING version',[previous.version+1,JSON.stringify(rules),input.reason,adminId])).rows[0];
  const after={version:row.version,cash_minor:input.cash};
  await c.query(`INSERT INTO platform_admin_audit_logs(actor_admin_id,actor_role,action,resource_type,resource_id,reason,before_data,after_data,request_id)
   VALUES($1,$2,'referral.threshold_published','growth_policy',$3,$4,$5,$6,$7)`,[adminId,admin.role,String(row.version),input.reason,JSON.stringify(before),JSON.stringify(after),requestId]);
  await c.query('COMMIT');return {...after,idempotent_replay:false};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
