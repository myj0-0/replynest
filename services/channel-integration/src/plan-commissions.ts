import type {PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {pool} from './database.js';
import {currentGrowthPolicy} from './growth-policy.js';
import {commissionAmount,retainedCommission,validateGrowthPolicy} from './growth-policy-core.js';
import {postLedgerInTransaction} from './ledger.js';
import {assessReferralRisk,type RiskSignalType} from './referral-risk-core.js';

// Called in the same buyer transaction: failed purchase cannot leave a commission.
export async function capturePlanCommission(c:PoolClient,p:any){
 if(Number(p.cash_minor)<=0)return;
 // Pre-release test attributions stay on their legacy fixed-reward path, never both paths.
 const r=(await c.query(`SELECT * FROM referrals WHERE invitee_tenant_id=$1 AND growth_policy_version IS NOT NULL AND status NOT IN ('rejected','revoked')`,[p.tenant_id])).rows[0];if(!r||r.inviter_tenant_id===p.tenant_id)return;
 const policy=await currentGrowthPolicy(c);
 const count=Number((await c.query(`SELECT COUNT(*)::int AS n FROM wallet_purchases WHERE tenant_id=$1 AND cash_minor>0`,[p.tenant_id])).rows[0].n);
 const rate=count===1?policy.rules.first_bps:policy.rules.repeat_bps;
 await c.query(`INSERT INTO plan_commissions(purchase_id,referral_id,inviter_tenant_id,invitee_tenant_id,policy_version,cash_minor,rate_bps,amount_minor,payment_kind,matures_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz+($11::int*INTERVAL '1 day')) ON CONFLICT(purchase_id) DO NOTHING`,[p.purchase_id,r.referral_id,r.inviter_tenant_id,p.tenant_id,policy.version,p.cash_minor,rate,commissionAmount(Number(p.cash_minor),rate),count===1?'first':'repeat',p.created_at,policy.rules.observation_days]);
}
// Refund fees do not earn commission; only the actual retained service usage does.
export async function reducePlanCommission(c:PoolClient,purchase:string,usage:number,total:number){
 const row=(await c.query('SELECT * FROM plan_commissions WHERE purchase_id=$1 FOR UPDATE',[purchase])).rows[0];if(!row)return;
 await c.query('UPDATE plan_commissions SET retained_minor=$2 WHERE commission_id=$1',[row.commission_id,retainedCommission(Number(row.amount_minor),usage,total)]);
}
async function settleOne(id:string,now:Date){const c=await pool.connect();try{
 await c.query('BEGIN');const buyer=(await c.query('SELECT invitee_tenant_id FROM plan_commissions WHERE commission_id=$1',[id])).rows[0];if(!buyer){await c.query('COMMIT');return;}await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`wallet:${buyer.invitee_tenant_id}`]);
 const row=(await c.query(`SELECT c.*,r.status AS referral_status,r.growth_policy_version FROM plan_commissions c JOIN referrals r USING(referral_id) WHERE commission_id=$1 FOR UPDATE OF c SKIP LOCKED`,[id])).rows[0];if(!row){await c.query('COMMIT');return;}
 if(['rejected','revoked'].includes(row.referral_status)&&row.status!=='posted'){await c.query(`UPDATE plan_commissions SET status='rejected',review_note='Referral is not eligible' WHERE commission_id=$1`,[id]);await c.query('COMMIT');return;}
 if(row.status==='pending'){
  if(new Date(row.matures_at)>now||(await c.query(`SELECT 1 FROM wallet_requests WHERE purchase_id=$1 AND status IN ('requested','approved')`,[row.purchase_id])).rowCount){await c.query('COMMIT');return;}
  const signals=(await c.query<{signal_type:RiskSignalType;confidence:'high'|'medium'|'low'}>(`SELECT DISTINCT a.signal_type,a.confidence FROM tenant_risk_signals a JOIN tenant_risk_signals b ON a.signal_type=b.signal_type AND a.fingerprint_hash=b.fingerprint_hash WHERE a.tenant_id=$1 AND b.tenant_id=$2 AND NOT EXISTS(SELECT 1 FROM tenant_risk_signal_revocations v WHERE v.signal_id IN(a.signal_id,b.signal_id))`,[row.inviter_tenant_id,row.invitee_tenant_id])).rows;
  const flags=(await c.query(`SELECT EXISTS(SELECT 1 FROM tenant_memberships a JOIN tenant_memberships b USING(platform_user_id) WHERE a.tenant_id=$1 AND b.tenant_id=$2 AND a.status='active' AND b.status='active') AS shared,EXISTS(SELECT 1 FROM tenant_trial_signals WHERE tenant_id IN($1,$2) AND risk_state<>'clear') AS restricted`,[row.inviter_tenant_id,row.invitee_tenant_id])).rows[0];
  const risk=assessReferralRisk(signals);
  if(!row.reviewed_by&&(risk.outcome!=='allow'||flags.shared||flags.restricted)){await c.query(`UPDATE plan_commissions SET status='review',review_note='Risk review required' WHERE commission_id=$1`,[id]);await c.query('COMMIT');return;}
 }
 const retained=Number(row.retained_minor??row.amount_minor),posted=Number(row.amount_minor),actor={actor_id:'plan-commission-worker',request_id:randomUUID()};
 if(row.status==='pending'){
  const ledger=retained?await postLedgerInTransaction(c,row.inviter_tenant_id,{transaction_type:'referral_reward',currency:'CNY',idempotency_key:`plan-commission:${id}`,source_type:'referral_plan_commission',source_id:id,occurred_at:new Date(row.matures_at).toISOString(),metadata:{purchase_id:row.purchase_id,policy_version:row.policy_version,rate_bps:row.rate_bps},entries:[{account:'clearing',direction:'debit',amount_minor:retained},{account:'referral',direction:'credit',amount_minor:retained}]},actor):null;
  await c.query(`UPDATE plan_commissions SET status='posted',ledger_transaction_id=$2,reversal_minor=$3 WHERE commission_id=$1`,[id,ledger?.transaction_id??null,posted-retained]);
  // New invitees get one optional gift, only after their first non-refunded cash plan qualifies.
  if(row.growth_policy_version&&row.retained_minor===null&&row.payment_kind==='first'){
   const rules=validateGrowthPolicy((await c.query('SELECT rules FROM growth_policy_versions WHERE version=$1',[row.growth_policy_version])).rows[0].rules);
   if(rules.invitee_gift_minor)await postLedgerInTransaction(c,row.invitee_tenant_id,{transaction_type:'gift_grant',currency:'CNY',idempotency_key:`referral-invitee:${row.referral_id}`,source_type:'referral_invitee_gift',source_id:row.referral_id,occurred_at:new Date(row.matures_at).toISOString(),entries:[{account:'clearing',direction:'debit',amount_minor:rules.invitee_gift_minor},{account:'gift',direction:'credit',amount_minor:rules.invitee_gift_minor,expires_at:new Date(new Date(row.matures_at).getTime()+rules.gift_expiry_days*86400000).toISOString()}]},actor);
  }
 }else if(row.status==='posted'&&posted-retained>Number(row.reversal_minor)){
  const delta=posted-retained-Number(row.reversal_minor);
  await postLedgerInTransaction(c,row.inviter_tenant_id,{transaction_type:'adjustment',currency:'CNY',idempotency_key:`plan-commission-reverse:${id}:${retained}`,source_type:'referral_plan_reversal',source_id:id,occurred_at:new Date().toISOString(),entries:[{account:'referral',direction:'debit',amount_minor:delta},{account:'clearing',direction:'credit',amount_minor:delta}]},actor);
  await c.query('UPDATE plan_commissions SET reversal_minor=$2 WHERE commission_id=$1',[id,posted-retained]);
 }
 await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
export async function processPlanCommissions(now=new Date()){
 const ids=(await pool.query(`SELECT commission_id FROM plan_commissions WHERE (status='pending' AND matures_at<=$1) OR (status='posted' AND retained_minor IS NOT NULL AND amount_minor-retained_minor>reversal_minor) ORDER BY matures_at LIMIT 50`,[now])).rows;
 // Global worker lock avoids opposite-direction inviter/invitee wallet deadlocks.
 const c=await pool.connect();try{if(!(await c.query("SELECT pg_try_advisory_lock(hashtext('plan-commission-worker')) AS locked")).rows[0].locked)return;try{for(const r of ids)await settleOne(r.commission_id,now);}finally{await c.query("SELECT pg_advisory_unlock(hashtext('plan-commission-worker'))");}}finally{c.release();}
}
export async function reviewPlanCommission(id:string,action:string,reason:unknown,admin:string,role:string,requestId:string){
 if(!['approve','reject'].includes(action)||typeof reason!=='string'||reason.trim().length<10||reason.length>500)throw new Error('invalid_review');const c=await pool.connect();try{await c.query('BEGIN');
 const result=await c.query(`UPDATE plan_commissions SET status=$2,reviewed_by=$3,review_note=$4 WHERE commission_id=$1 AND status='review' RETURNING commission_id`,[id,action==='approve'?'pending':'rejected',admin,reason.trim()]);if(!result.rowCount)throw new Error('review_state_changed');
 await c.query(`INSERT INTO platform_admin_audit_logs(actor_admin_id,actor_role,action,resource_type,resource_id,reason,request_id) VALUES($1,$2,$3,'plan_commission',$4,$5,$6)`,[admin,role,`growth.commission_${action}`,id,reason.trim(),requestId]);await c.query('COMMIT');return result.rows[0];
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
