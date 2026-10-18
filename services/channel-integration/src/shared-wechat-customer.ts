import { createHash } from "node:crypto";
import type { Pool } from "pg";

/** Materialize a tenant-local profile only from a verified shared thread. Never merge tenants. */
export async function ensureSharedWechatCustomer(db: Pool, tenantId: string, conversationId: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`shared-profile:${tenantId}:${conversationId}`]);
    const thread = await client.query(`SELECT b.app_id,b.open_id,b.contact_id::text FROM shared_wechat_threads b
      JOIN tenants t ON t.tenant_id=b.tenant_id AND t.chatwoot_account_id=b.account_id
      WHERE b.tenant_id=$1 AND b.conversation_id=$2`, [tenantId,conversationId]);
    if (!thread.rows[0]) { await client.query("COMMIT"); return; }
    const externalId = createHash("sha256").update(JSON.stringify([thread.rows[0].app_id,tenantId,thread.rows[0].open_id])).digest("hex");
    const known = await client.query(`SELECT customer_id FROM channel_identities WHERE tenant_id=$1 AND channel='shared_wechat' AND external_user_id=$2`,[tenantId,externalId]);
    if (!known.rows[0]) {
      const customer = await client.query(`INSERT INTO customers(tenant_id,name) VALUES($1,'微信访客') RETURNING customer_id`,[tenantId]);
      await client.query(`INSERT INTO channel_identities(tenant_id,customer_id,channel,external_user_id,chatwoot_source_id,chatwoot_conversation_id,chatwoot_contact_id)
        VALUES($1,$2,'shared_wechat',$3,$3,$4,$5)`,[tenantId,customer.rows[0].customer_id,externalId,conversationId,thread.rows[0].contact_id??null]);
    } else {
      // Fill only a verified, same-thread missing native ID; never overwrite a known binding.
      await client.query(`UPDATE channel_identities SET chatwoot_contact_id=$4 WHERE tenant_id=$1 AND channel='shared_wechat'
        AND external_user_id=$2 AND chatwoot_conversation_id=$3 AND chatwoot_contact_id IS NULL AND $4::bigint IS NOT NULL`,
        [tenantId,externalId,conversationId,thread.rows[0].contact_id??null]);
    }
    await client.query("COMMIT");
  } catch(error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
