import type {Pool} from 'pg';
import {executeStoredMassBatch,type StoredMassAdapter} from './mass-campaign-runtime.js';
import {recoverMassBatches} from './mass-campaign-store.js';

/** One bounded tick; queued batches only. No uncertain/submitted batch can be selected. */
export async function processDueMassBatch(db:Pick<Pool,'query'|'connect'>,adapter:StoredMassAdapter){
 if(!adapter.enabled())return 'disabled' as const;
 await recoverMassBatches(db);
 const due=await db.query(`SELECT b.tenant_id,b.campaign_id,b.batch_id FROM message_campaign_mass_batches b
  JOIN message_campaigns c ON c.tenant_id=b.tenant_id AND c.campaign_id=b.campaign_id
  WHERE b.state='queued' AND b.available_at<=NOW() AND c.status IN('scheduled','running') AND c.scheduled_at<=NOW()
  ORDER BY b.available_at,b.batch_id LIMIT 1`);
 const b=due.rows[0];if(!b)return 'idle' as const;
 return executeStoredMassBatch(db,{tenantId:b.tenant_id,campaignId:b.campaign_id,batchId:b.batch_id},adapter);
}

/** Read-only derived state. Provider success is batch-level, never a per-user delivery claim. */
export async function massCampaignOverview(db:Pick<Pool,'query'>,tenantId:string,campaignId:string){
 const exists=await db.query('SELECT 1 FROM message_campaigns WHERE tenant_id=$1 AND campaign_id=$2',[tenantId,campaignId]);
 if(!exists.rowCount)return null;
 const summary=await db.query(`SELECT state,COUNT(*)::int batches FROM message_campaign_mass_batches
  WHERE tenant_id=$1 AND campaign_id=$2 GROUP BY state`,[tenantId,campaignId]);
 const counts:Record<string,number>=Object.fromEntries(summary.rows.map(r=>[r.state,r.batches]));
 const total=Object.values(counts).reduce((a,b)=>a+b,0);
 const status=!total?'not_staged':counts.uncertain?'needs_review':counts.queued||counts.preparing||counts.submitting||counts.submitted?'in_progress':counts.blocked||counts.failed||counts.deleted?'attention':'provider_succeeded';
 const rows=await db.query(`SELECT batch_id,state,reason,available_at,defer_count,query_attempts,created_at,updated_at FROM message_campaign_mass_batches
  WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY created_at DESC,batch_id DESC LIMIT 51`,[tenantId,campaignId]);
 const batches=rows.rows.slice(0,50);
 const reviews=await db.query(`SELECT b.batch_id,r.review_id,r.reason,r.created_at FROM message_campaign_mass_batches b
  CROSS JOIN LATERAL (SELECT review_id,reason,created_at FROM message_campaign_mass_reviews
   WHERE tenant_id=b.tenant_id AND campaign_id=b.campaign_id AND batch_id=b.batch_id
   ORDER BY created_at DESC,review_id DESC LIMIT 3) r
  WHERE b.tenant_id=$1 AND b.campaign_id=$2 AND b.batch_id=ANY($3::uuid[])`,[tenantId,campaignId,batches.map(b=>b.batch_id)]);
 return {status,total,counts,batches:batches.map(b=>({...b,reviews:reviews.rows.filter(r=>r.batch_id===b.batch_id)})),has_more:rows.rows.length>50};
}
