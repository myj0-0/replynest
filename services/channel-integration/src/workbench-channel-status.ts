import type { Pool } from 'pg';

// Configuration presence, not a health check; upstream failures remain errors.
export async function workbenchChannelStatus(db: Pick<Pool,'query'>, tenantId: string) {
  const result = await db.query<{connected: boolean}>(`SELECT (
    EXISTS(SELECT 1 FROM channel_connections WHERE tenant_id=$1 AND status='ready'
      AND COALESCE(configuration->>'mode','')<>'synthetic')
    OR EXISTS(SELECT 1 FROM shared_wechat_enrollments e
      JOIN shared_wechat_inboxes i ON i.app_id=e.app_id AND i.tenant_id=e.tenant_id
      JOIN tenants t ON t.tenant_id=e.tenant_id AND t.chatwoot_account_id=i.account_id
      WHERE e.tenant_id=$1 AND e.enabled=TRUE AND i.enabled=TRUE)
    ) AS connected`, [tenantId]);
  return {connected: result.rows[0]?.connected === true};
}
