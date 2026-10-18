import {pool} from './database.js';
import type {PoolClient} from 'pg';
export const referralPartnerEnabled=(env:NodeJS.ProcessEnv=process.env)=>env.REFERRAL_PARTNER_ACCESS_ENABLED==='true';
type Db=Pick<PoolClient,'query'>;
export type PartnerAccess={enabled:boolean;version:number;reason?:string;updated_by?:string;updated_at?:string};
export async function readReferralPartner(tenant:string,db:Db=pool):Promise<PartnerAccess>{
 if(!referralPartnerEnabled())return {enabled:false,version:0};
 return (await db.query('SELECT enabled,version,reason,updated_by,updated_at FROM tenant_referral_partner_access WHERE tenant_id=$1',[tenant])).rows[0]??{enabled:false,version:0};
}
export async function lockReferralPartner(db:Db,tenant:string){
 await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['referral-partner:'+tenant]);
}
export function validatePartnerChange(raw:Record<string,unknown>){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['tenant_id','enabled','expected_version','reason'].includes(k))||typeof raw.tenant_id!=='string'||!raw.tenant_id.trim()||raw.tenant_id.length>200||typeof raw.enabled!=='boolean'||!Number.isSafeInteger(raw.expected_version)||Number(raw.expected_version)<0||Number(raw.expected_version)>2147483646||typeof raw.reason!=='string'||raw.reason.trim().length<10||raw.reason.trim().length>500)throw Error('invalid_partner_change');
 return {tenant:raw.tenant_id,enabled:raw.enabled,version:Number(raw.expected_version),reason:raw.reason.trim()};
}
/** Owner/admin only. Durable configuration and its audit entry commit together. */
export async function setReferralPartner(raw:Record<string,unknown>,adminId:string,requestId:string){
 if(!referralPartnerEnabled())throw Error('referral_partner_disabled');
 const input=validatePartnerChange(raw),c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'");
  const admin=(await c.query("SELECT role FROM platform_admin_accounts WHERE admin_id=$1 AND status='active' AND role IN('owner','admin') FOR SHARE",[adminId])).rows[0];
  if(!admin)throw Error('forbidden');
  await lockReferralPartner(c,input.tenant);
  const tenant=(await c.query('SELECT status FROM tenants WHERE tenant_id=$1 FOR SHARE',[input.tenant])).rows[0];
  if(!tenant)throw Error('tenant_not_found');
  if(input.enabled&&tenant.status!=='active')throw Error('active_tenant_required');
  const before=await readReferralPartner(input.tenant,c);
  if(before.version!==input.version)throw Error('partner_version_conflict');
  if(before.enabled===input.enabled){await c.query('COMMIT');return {...before,idempotent_replay:true};}
  const after=(await c.query(`INSERT INTO tenant_referral_partner_access(tenant_id,enabled,version,reason,updated_by)
   VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id) DO UPDATE SET enabled=EXCLUDED.enabled,version=EXCLUDED.version,
   reason=EXCLUDED.reason,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()
   RETURNING enabled,version,reason,updated_by,updated_at`,[input.tenant,input.enabled,before.version+1,input.reason,adminId])).rows[0];
  await c.query(`INSERT INTO platform_admin_audit_logs(actor_admin_id,actor_role,action,resource_type,resource_id,tenant_id,reason,before_data,after_data,request_id)
   VALUES($1,$2,'referral.partner_access_changed','referral_partner_access',$3,$3,$4,$5,$6,$7)`,[adminId,admin.role,input.tenant,input.reason,JSON.stringify(before),JSON.stringify(after),requestId]);
  await c.query('COMMIT');return {...after,idempotent_replay:false};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
