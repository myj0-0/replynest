import type {PoolClient} from 'pg';
import {assertCapacity} from './subscriptions.js';
// Caller owns the transaction; all upload and marketplace writers use this tenant lock.
export async function lockKnowledgeCapacity(c:PoolClient,tenant:string,bytes:number) {
 if(!Number.isSafeInteger(bytes)||bytes<0)throw new Error('invalid_knowledge_size');
 await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`knowledge-capacity:${tenant}`]);
 const row=(await c.query(`SELECT COALESCE(SUM(COALESCE(file_size,octet_length(content))),0)::text used FROM knowledge_documents WHERE tenant_id=$1 AND status<>'deleted'`,[tenant])).rows[0];
 await assertCapacity(tenant,'knowledge_bytes',Number(row.used),bytes,c);
}
