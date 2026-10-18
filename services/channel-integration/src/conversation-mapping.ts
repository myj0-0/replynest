import type {Pool} from 'pg';
export async function ensureConversationMapping(
  db:Pick<Pool,'query'>,
  tenantId: string,
  type: string,
  accountId: string,
  chatwootId: string,
  parentId: string | null = null
): Promise<string> {
  // Existing mappings are immutable identities; polling must not rewrite their tuples.
  const existing=await db.query<{replynest_resource_id:string;parent_replynest_resource_id:string|null}>(
    `SELECT replynest_resource_id,parent_replynest_resource_id FROM conversation_resource_mappings
      WHERE tenant_id=$1 AND resource_type=$2 AND chatwoot_account_id=$3 AND chatwoot_resource_id=$4`,
    [tenantId,type,accountId,chatwootId]);
  if(existing.rows[0]&&(!parentId||existing.rows[0].parent_replynest_resource_id))return existing.rows[0].replynest_resource_id;
  const result = await db.query<{ replynest_resource_id: string }>(
    `INSERT INTO conversation_resource_mappings
       (tenant_id,resource_type,chatwoot_account_id,chatwoot_resource_id,parent_replynest_resource_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id,resource_type,chatwoot_account_id,chatwoot_resource_id)
     DO UPDATE SET parent_replynest_resource_id=COALESCE(conversation_resource_mappings.parent_replynest_resource_id,EXCLUDED.parent_replynest_resource_id)
     RETURNING replynest_resource_id`,
    [tenantId, type, accountId, chatwootId, parentId]
  );
  return result.rows[0].replynest_resource_id;
}
