import type {PoolClient} from 'pg';
import {claimMassReceipt,reconcileMassReceipt,type MassReceiptLease} from './mass-campaign-store.js';
import {massStatus} from './wechat-mass-core.js';

/** Query-only worker: no send adapter is accepted, and no state is ever requeued. */
export async function processMassReceipt(db:Pick<PoolClient,'query'>,query:(lease:MassReceiptLease)=>Promise<Record<string,unknown>>){
 const lease=await claimMassReceipt(db);if(!lease)return false;
 try{
  const result=await query(lease);
  await reconcileMassReceipt(db,lease,massStatus(result,lease.receiptId));
 }catch{
  // Keep the durable two-minute lease/backoff. After 20 attempts require review.
  // Do not persist provider text which could contain secrets or customer data.
  await db.query(`UPDATE message_campaign_mass_batches SET reason='receipt_query_unavailable',updated_at=NOW()
   WHERE tenant_id=$1 AND batch_id=$2 AND query_token=$3 AND state='submitted'`,[lease.tenantId,lease.batchId,lease.queryToken]);
 }
 return true;
}
