import type {PoolClient} from 'pg';

export type MassCampaignMetrics={pending_batches:number;paused_batches:number;awaiting_receipt_batches:number;
 uncertain_batches:number;succeeded_batches_24h:number;unsuccessful_batches_24h:number};

/** One tenant only; current queues and recent terminal outcomes are different windows.
 * Batch counts must never be multiplied into a claim of individual delivery/read receipts. */
export const tenantMassMetricsSql=`WITH live AS (
 SELECT COUNT(*) FILTER(WHERE b.state IN('queued','preparing','submitting') AND c.status IN('scheduled','running'))::int AS pending_batches,
 COUNT(*) FILTER(WHERE b.state IN('queued','preparing','submitting') AND c.status='paused')::int AS paused_batches,
 COUNT(*) FILTER(WHERE b.state='submitted')::int AS awaiting_receipt_batches,
 COUNT(*) FILTER(WHERE b.state='uncertain')::int AS uncertain_batches
 FROM message_campaign_mass_batches b JOIN message_campaigns c ON c.tenant_id=b.tenant_id AND c.campaign_id=b.campaign_id
 WHERE b.tenant_id=$1 AND b.state IN('queued','preparing','submitting','submitted','uncertain')
), recent AS (
 SELECT COUNT(*) FILTER(WHERE state='succeeded')::int AS succeeded_batches_24h,
 COUNT(*) FILTER(WHERE state IN('blocked','failed','deleted'))::int AS unsuccessful_batches_24h
 FROM message_campaign_mass_batches WHERE tenant_id=$1 AND state IN('succeeded','blocked','failed','deleted')
 AND updated_at>=NOW()-INTERVAL '24 hours'
)
SELECT live.*,recent.* FROM live CROSS JOIN recent`;

export async function tenantMassCampaignMetrics(db:Pick<PoolClient,'query'>,tenantId:string):Promise<MassCampaignMetrics>{
 if(!tenantId.trim())throw Error('mass_metrics_tenant_required');
 return (await db.query<MassCampaignMetrics>(tenantMassMetricsSql,[tenantId])).rows[0];
}
