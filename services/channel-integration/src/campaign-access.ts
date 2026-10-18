import type {PoolClient} from 'pg';
import {pool} from './database.js';
import {effectiveEntitlement} from './subscriptions.js';
import {campaignAccessDecision} from './campaign-access-core.js';

type Db = Pick<PoolClient, 'query'>;
export async function tenantCampaignAccess(tenantId: string, db: Db = pool) {
  const entitlement = await effectiveEntitlement(tenantId, db);
  const tenant = (await db.query('SELECT status FROM tenants WHERE tenant_id=$1', [tenantId])).rows[0];
  const channels = (await db.query(`SELECT connection_id,tenant_id,channel_type,status,external_account_id
    FROM channel_connections WHERE tenant_id=$1 AND channel_type='wechat_official_account' AND status='ready'
    ORDER BY connection_id LIMIT 101`, [tenantId])).rows;
  // Shared-account tables are optional in independent-only installations.
  const sharedTable = (await db.query("SELECT to_regclass('shared_wechat_accounts') IS NOT NULL AS present")).rows[0].present;
  const sharedIds = new Set<string>(process.env.SHARED_WECHAT_APP_ID ? [process.env.SHARED_WECHAT_APP_ID] : []);
  if (sharedTable && channels.length) {
    const rows = await db.query('SELECT app_id FROM shared_wechat_accounts WHERE app_id=ANY($1::text[])', [channels.map(c => c.external_account_id)]);
    for (const row of rows.rows) sharedIds.add(row.app_id);
  }
  const eligible = channels.filter(c => !campaignAccessDecision({
    tenantId, connectionTenantId: c.tenant_id, tenantStatus: tenant?.status ?? '',
    planCode: entitlement.plan.code, channelType: c.channel_type, channelStatus: c.status,
    appId: c.external_account_id ?? '', sharedApp: sharedIds.has(c.external_account_id),
  }));
  const reason = !['active','test'].includes(tenant?.status) ? 'campaign_tenant_inactive'
    : entitlement.plan.code !== 'professional' ? 'campaign_professional_required'
    : eligible.length > 1 ? 'campaign_channel_selection_required'
    : eligible.length === 0 ? 'campaign_independent_channel_required' : null;
  return {eligible: reason === null, reason, connection_id: reason === null ? String(eligible[0].connection_id) : null};
}
