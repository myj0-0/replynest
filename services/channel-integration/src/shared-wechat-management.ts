import type { Pool } from "pg";
import { sceneToken } from "./shared-wechat-routing.js";
import { sharedWechatMerchantSchemaSql,migrateSharedWechatMerchant,merchantProfile } from './shared-wechat-merchant.js';

function managementOnlySchemaSql(): string {
  return `CREATE TABLE IF NOT EXISTS shared_wechat_requests (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id), requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  ); CREATE TABLE IF NOT EXISTS shared_wechat_management_events (
    id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
    actor_id TEXT NOT NULL,action TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`;
}
export function sharedWechatManagementSchemaSql(): string {return sharedWechatMerchantSchemaSql()+managementOnlySchemaSql();}
export async function migrateSharedWechatManagement(db: Pool) {
  await migrateSharedWechatMerchant(db);
  await db.query(managementOnlySchemaSql());
}
export type SharedManagementActor = { tenantId: string; actorId: string; role: string };
export type SharedManagementOptions = { appId: string; entryReady: boolean;
  issueQr: (scene: string, permanent?: boolean) => Promise<{ imageUrl: string; expiresIn: number | null }> };

export async function sharedWechatOverview(db: Pool, tenantId: string, options: SharedManagementOptions) {
  const [request,enrollment,scenes] = await Promise.all([
    db.query(`SELECT requested_at FROM shared_wechat_requests WHERE tenant_id=$1`,[tenantId]),
    db.query(`SELECT e.enabled,a.enabled AS account_enabled,
      EXISTS(SELECT 1 FROM shared_wechat_inboxes i JOIN tenants t ON t.tenant_id=i.tenant_id AND t.chatwoot_account_id=i.account_id
        WHERE i.app_id=e.app_id AND i.tenant_id=e.tenant_id AND i.enabled=TRUE AND t.status IN ('active','test')) AS inbox_ready
      FROM shared_wechat_enrollments e JOIN shared_wechat_accounts a ON a.app_id=e.app_id WHERE e.app_id=$1 AND e.tenant_id=$2`,[options.appId,tenantId]),
    db.query(`SELECT digest,expires_at,revoked FROM shared_wechat_scenes WHERE app_id=$1 AND tenant_id=$2 AND (expires_at IS NULL OR expires_at>NOW()) ORDER BY expires_at DESC LIMIT 20`,[options.appId,tenantId])
  ]);
  const enabled=enrollment.rows[0]?.enabled === true;
  const profile=(await db.query('SELECT introduction,website FROM shared_wechat_merchant_profiles WHERE tenant_id=$1',[tenantId])).rows[0]??{introduction:'',website:''};
  return { available:true,profile,requested:!!request.rows[0],enabled,entry_ready:options.entryReady && enabled && enrollment.rows[0]?.account_enabled===true && enrollment.rows[0]?.inbox_ready===true,scenes:scenes.rows };
}

export async function manageSharedWechat(db: Pool, actor: SharedManagementActor, input: Record<string,unknown>, options: SharedManagementOptions) {
  if(actor.role!=="tenant_admin" || !actor.actorId) throw new Error("admin_required");
  const action=input.action;
  if(!["save_profile","request","disable","create_qr","revoke_qr"].includes(String(action)) || Object.keys(input).some(k=>k!=="action" && !(action==="save_profile" && ['introduction','website'].includes(k)) && !(action==="revoke_qr" && k==="digest") && !(action==="create_qr" && k==="permanent"))) throw new Error("invalid_input");
  if(input.permanent!==undefined && typeof input.permanent!=="boolean") throw new Error("invalid_input");
  if(action==="revoke_qr" && !/^[a-f0-9]{64}$/.test(String(input.digest??""))) throw new Error("invalid_input");
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    const tenant=await client.query(`SELECT tenant_id FROM tenants WHERE tenant_id=$1 AND status IN ('active','test') FOR SHARE`,[actor.tenantId]);
    if(!tenant.rows[0]) throw new Error("tenant_unavailable");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`shared-management:${actor.tenantId}`]);
    let data: Record<string,unknown>={};
    if(action==="save_profile") {
      const p=merchantProfile(input);
      await client.query(`INSERT INTO shared_wechat_merchant_profiles(tenant_id,introduction,website) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET introduction=$2,website=$3,updated_at=NOW()`,[actor.tenantId,p.introduction,p.website]);data=p;
    } else if(action==="request") {
      // Request is NOT approval. Only a platform operator may provision an enrollment/inbox.
      await client.query(`INSERT INTO shared_wechat_requests(tenant_id) VALUES($1) ON CONFLICT DO NOTHING`,[actor.tenantId]);
      data={requested:true};
    } else if(action==="disable") {
      await client.query(`UPDATE shared_wechat_enrollments SET enabled=FALSE WHERE app_id=$1 AND tenant_id=$2`,[options.appId,actor.tenantId]);
      await client.query(`UPDATE shared_wechat_scenes SET revoked=TRUE WHERE app_id=$1 AND tenant_id=$2`,[options.appId,actor.tenantId]);
    } else if(action==="revoke_qr") {
      const result=await client.query(`UPDATE shared_wechat_scenes SET revoked=TRUE WHERE app_id=$1 AND tenant_id=$2 AND digest=$3 RETURNING digest`,[options.appId,actor.tenantId,input.digest]);
      if(!result.rows[0]) throw new Error("qr_not_found");
    } else {
      if(!options.entryReady) throw new Error("entry_not_ready");
      const gate=await client.query(`SELECT e.tenant_id FROM shared_wechat_enrollments e
        JOIN shared_wechat_accounts a ON a.app_id=e.app_id AND a.enabled=TRUE
        JOIN shared_wechat_inboxes i ON i.app_id=e.app_id AND i.tenant_id=e.tenant_id AND i.enabled=TRUE
        JOIN tenants t ON t.tenant_id=e.tenant_id AND t.chatwoot_account_id=i.account_id
        WHERE e.app_id=$1 AND e.tenant_id=$2 AND e.enabled=TRUE FOR SHARE OF e,a,i,t`,[options.appId,actor.tenantId]);
      if(!gate.rows[0]) throw new Error("entry_not_ready");
      const count=await client.query(`SELECT COUNT(*)::int AS n FROM shared_wechat_scenes WHERE app_id=$1 AND tenant_id=$2 AND (expires_at IS NULL OR expires_at>NOW()) AND revoked=FALSE`,[options.appId,actor.tenantId]);
      if(count.rows[0].n>=3) throw new Error("qr_limit_reached");
      const recent=await client.query(`SELECT 1 FROM shared_wechat_management_events WHERE tenant_id=$1 AND action='create_qr' AND created_at>NOW()-INTERVAL '1 minute' LIMIT 1`,[actor.tenantId]);
      if(recent.rows[0]) throw new Error("qr_rate_limited");
      const scene=sceneToken(),issuedAt=Date.now();
      const qr=await options.issueQr(scene.value,input.permanent===true);
      const qrUrl=new URL(qr.imageUrl);
      if(qrUrl.origin!=="https://mp.weixin.qq.com" || qrUrl.pathname!=="/cgi-bin/showqrcode" || qrUrl.username || qrUrl.password || !qrUrl.searchParams.get("ticket") || (input.permanent===true ? qr.expiresIn!==null : (!Number.isInteger(qr.expiresIn) || qr.expiresIn===null || qr.expiresIn<1 || qr.expiresIn>1800))) throw new Error("qr_provider_failed");
      const expires=qr.expiresIn===null?null:new Date(issuedAt+qr.expiresIn*1000).toISOString();
      await client.query(`INSERT INTO shared_wechat_scenes(app_id,digest,tenant_id,expires_at) VALUES($1,$2,$3,$4)`,[options.appId,scene.digest,actor.tenantId,expires]);
      data={digest:scene.digest,image_url:qr.imageUrl,expires_at:expires};
    }
    await client.query(`INSERT INTO shared_wechat_management_events(tenant_id,actor_id,action) VALUES($1,$2,$3)`,[actor.tenantId,actor.actorId,action]);
    await client.query("COMMIT"); return data;
  } catch(error) {await client.query("ROLLBACK");throw error;} finally {client.release();}
}
