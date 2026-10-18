import type { Pool } from "pg";
import { deliverSharedWechatInbound, type SharedTransport } from "./shared-wechat-delivery.js";
import type {InsightReceiptHooks} from './customer-insights-sources.js';

export type SharedWorkerResult = { selected:number; delivered:number; uncertain:number; blocked:number; duplicate:number; errors:number; locked:boolean };

/** Bounded, inbound-only worker. A session advisory lock prevents concurrent batch
 * selection across instances. Delivery also durably deduplicates each receipt.
 * An ambiguous write is never retried automatically, nor bypassed by a later message.
 */
export async function processSharedWechatInboundBatch(db:Pool,transport:SharedTransport,options:{enabled:boolean;batchSize?:number;insights?:InsightReceiptHooks['shared']}):Promise<SharedWorkerResult> {
  const result:SharedWorkerResult={selected:0,delivered:0,uncertain:0,blocked:0,duplicate:0,errors:0,locked:false};
  if(!options.enabled)return result;
  const limit=options.batchSize??10;
  if(!Number.isInteger(limit)||limit<1||limit>50)throw new Error("invalid_shared_batch_size");
  const client=await db.connect();let locked=false;
  try {
    const lock=await client.query(`SELECT pg_try_advisory_lock(hashtext('replynest-shared-wechat-inbound-worker')) AS locked`);
    locked=lock.rows[0].locked===true;
    if(!locked){result.locked=true;return result;}
    const jobs=await client.query(`SELECT app_id,event_id FROM (
      SELECT r.app_id,r.event_id,r.created_at,
        ROW_NUMBER() OVER(PARTITION BY r.app_id,r.destination_tenant_id,r.open_id ORDER BY r.created_at,r.event_id) AS position
      FROM shared_wechat_receipts r
      JOIN shared_wechat_accounts a ON a.app_id=r.app_id AND a.enabled=TRUE
      JOIN shared_wechat_enrollments e ON e.app_id=r.app_id AND e.tenant_id=r.destination_tenant_id AND e.enabled=TRUE
      JOIN tenants t ON t.tenant_id=e.tenant_id AND t.status IN ('active','test')
      JOIN shared_wechat_inboxes i ON i.app_id=e.app_id AND i.tenant_id=e.tenant_id AND i.enabled=TRUE AND i.account_id=t.chatwoot_account_id
      WHERE r.delivery_state='held' AND r.decision->>'action'='route' AND r.text_content IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM shared_wechat_deliveries d WHERE d.app_id=r.app_id AND d.direction='in' AND d.command_id=r.event_id)
        AND NOT EXISTS(SELECT 1 FROM shared_wechat_deliveries d WHERE d.app_id=r.app_id AND d.tenant_id=r.destination_tenant_id AND d.open_id=r.open_id AND d.direction='in' AND d.status='uncertain')
    ) ready WHERE position=1 ORDER BY created_at,event_id LIMIT $1`,[limit]);
    result.selected=jobs.rows.length;
    for(const job of jobs.rows) {
      try {
        const outcome=await deliverSharedWechatInbound(db,job.app_id,job.event_id,transport,{insights:options.insights});
        if(outcome==="delivered"||outcome==="uncertain"||outcome==="blocked"||outcome==="duplicate")result[outcome]++;
        else result.errors++;
      } catch {result.errors++;}
    }
    return result;
  } finally {
    try {
      if(locked)await client.query(`SELECT pg_advisory_unlock(hashtext('replynest-shared-wechat-inbound-worker'))`);
      client.release();
    } catch(error) {client.release(error instanceof Error?error:new Error("shared_worker_unlock_failed"));}
  }
}
