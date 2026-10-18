import type {Pool,PoolClient} from 'pg';
import {executeMassCampaign,type MassJob,type MassBatch} from './mass-campaign-executor.js';
import {claimMassBatch,commitMassSubmitting,deferMassBatch,finishMassBatch,MAX_MASS_DEFERRALS,type MassLease} from './mass-campaign-store.js';

export type MassEligibility=boolean|{allowed:boolean;reason:string;retryAt?:Date};

export type StoredMassAdapter={
 enabled():boolean;
 /** Read-only policy check: current plan, shared-account exclusion, consent, quiet time and quota. */
 prepare(lease:MassLease):Promise<MassEligibility>;
 /** Same checks under DB locks. Caller must lock campaign/consent rows consistently. */
 authorize(client:PoolClient,lease:MassLease):Promise<MassEligibility>;
 /** No retries. Destination is the stored tenant/connection/app snapshot, not model output. */
 submit(lease:MassLease,batch:MassBatch):Promise<string>;
};

/** Durable wiring. Production polling is independently gated and disabled by default. */
export async function executeStoredMassBatch(db:Pick<Pool,'query'|'connect'>,job:MassJob,adapter:StoredMassAdapter){
 if(!adapter.enabled())return 'disabled' as const;
 let lease:MassLease|null=null;
 let denied:Exclude<MassEligibility,boolean>|null=null;
 const allowed=(decision:MassEligibility)=>{
  denied=typeof decision==='boolean'||decision.allowed?null:decision;
  return typeof decision==='boolean'?decision:decision.allowed;
 };
 return executeMassCampaign(job,{
  claim:async()=>{lease=await claimMassBatch(db,job);return !!lease;},
  prepare:async()=>adapter.enabled()&&allowed(await adapter.prepare(lease!))?lease!.batch:null,
  commitSubmitting:async(_,batch)=>{
   const client=await db.connect();
   try{
    await client.query('BEGIN');
    if(!adapter.enabled()||!allowed(await adapter.authorize(client,lease!))){
     await client.query('ROLLBACK');return false;
    }
    const committed=await commitMassSubmitting(client,lease!,batch);
    await client.query('COMMIT');return committed;
   }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
   finally{client.release();}
  },
  defer:async()=>!!denied?.retryAt&&await deferMassBatch(db,lease!,denied.reason,denied.retryAt),
  submit:async(_,batch)=>{
   if(!adapter.enabled())throw Error('mass_execution_disabled_after_barrier');
   return adapter.submit(lease!,batch);
  },
  finish:async(_,state,receipt)=>{
   if(state==='blocked'&&denied)await db.query(`UPDATE message_campaign_mass_batches SET reason=CASE WHEN defer_count>=${MAX_MASS_DEFERRALS} AND $4 IN('campaign_rate_limited','campaign_quiet_hours') THEN 'campaign_defer_limit_reached' ELSE $4 END,updated_at=NOW()
    WHERE tenant_id=$1 AND batch_id=$2 AND worker_token=$3 AND state='preparing'`,[lease!.tenantId,lease!.batchId,lease!.workerToken,denied.reason]);
   await finishMassBatch(db,lease!,state,receipt);
  },
 });
}
