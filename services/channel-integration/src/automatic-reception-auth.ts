import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
/** Caller owns a transaction. No tenant supplied by a client is used as authority. */
export async function authenticateAutomaticAdministrator(c:Pick<PoolClient,'query'>,token:string,options:{requireNativeAccount?:boolean}={}){
 if(!/^[a-f0-9]{64}$/.test(token))return null;
 const auth=(await c.query(`SELECT s.session_id,u.platform_user_id,t.tenant_id,t.chatwoot_account_id::text account_id
  FROM console_sessions s JOIN platform_users u ON u.platform_user_id=s.platform_user_id
  JOIN tenants t ON t.tenant_id=s.selected_tenant_id
  JOIN tenant_memberships m ON m.tenant_id=t.tenant_id AND m.platform_user_id=u.platform_user_id
  WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.last_seen_at>clock_timestamp()-INTERVAL '7 days'
   AND u.status='active' AND u.session_version=s.user_session_version AND s.session_scope='console'
   AND s.impersonation_id IS NULL AND s.impersonated_by_admin_id IS NULL AND t.status IN('active','test')
   AND m.status='active' AND m.role='tenant_admin'
   ${options.requireNativeAccount===false?'':"AND t.chatwoot_account_id IS NOT NULL AND m.chatwoot_sync_status='synced' AND m.chatwoot_account_id=t.chatwoot_account_id"}
  FOR SHARE OF s,u,t,m`,[createHash('sha256').update(token).digest('hex')])).rows[0];
 return auth??null;
}
/** One bounded counter row per real session, shared by all gateway processes. */
export async function consumeAutomaticManagementRate(db:{connect():Promise<PoolClient>},token:string,write:boolean,expectedTenant?:string){
 const c=await db.connect();try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms'");
  const auth=await authenticateAutomaticAdministrator(c,token);
  if(!auth){await c.query('ROLLBACK');return 'administrator_session_required' as const;}
  if(expectedTenant!==undefined&&auth.tenant_id!==expectedTenant){await c.query('ROLLBACK');return 'workspace_changed' as const;}
  const r=(await c.query(`INSERT INTO automatic_reception_management_rate(session_id,bucket,reads,writes)
   VALUES($1,date_trunc('minute',clock_timestamp()),$2,$3) ON CONFLICT(session_id) DO UPDATE SET
   bucket=date_trunc('minute',clock_timestamp()),
   reads=CASE WHEN automatic_reception_management_rate.bucket=date_trunc('minute',clock_timestamp()) THEN LEAST(automatic_reception_management_rate.reads+$2,121) ELSE $2 END,
   writes=CASE WHEN automatic_reception_management_rate.bucket=date_trunc('minute',clock_timestamp()) THEN LEAST(automatic_reception_management_rate.writes+$3,61) ELSE $3 END RETURNING reads,writes`,[auth.session_id,write?0:1,write?1:0])).rows[0];
  await c.query('COMMIT');return (write?r.writes>60:r.reads>120)?'rate_limited' as const:null;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
