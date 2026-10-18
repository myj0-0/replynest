import {massTextPayload} from './wechat-mass-core.js';
export type MassJob={tenantId:string;campaignId:string;batchId:string};
export type MassBatch={openIds:string[];content:string;clientId:string};
export type MassState='blocked'|'submitted'|'uncertain'|'failed';
export type MassPorts={
  claim(job:MassJob):Promise<boolean>;
  /** Fresh plan, channel ownership/shared-account, consent, quiet hours and quota checks. */
  prepare(job:MassJob):Promise<MassBatch|null>;
  /** Persist exact recipient/content hash and clientId; recheck cancellation before commit. */
  commitSubmitting(job:MassJob,batch:MassBatch):Promise<boolean>;
  /** Only after a confirmed pre-barrier policy denial; never after an ambiguous commit. */
  defer?(job:MassJob):Promise<boolean>;
  submit(job:MassJob,batch:MassBatch):Promise<string>;
  finish(job:MassJob,state:MassState,receiptId?:string):Promise<void>;
};
/** Submitted is not delivered. An independent status reconciler must use the receipt ID. */
export async function executeMassCampaign(job:MassJob,p:MassPorts):Promise<MassState|'duplicate'|'deferred'> {
  if(!await p.claim(job))return 'duplicate';
  let submitting=false;
  try {
    const prepared=await p.prepare(job);
    if(!prepared){if(await p.defer?.(job))return 'deferred';await p.finish(job,'blocked');return 'blocked';}
    // Validate and freeze the exact snapshot before the durable send barrier.
    // A later callback must not alter recipients/content after their hash is saved.
    const payload=massTextPayload(prepared.openIds,prepared.content,prepared.clientId);
    const batch:MassBatch=Object.freeze({openIds:Object.freeze([...payload.touser]) as unknown as string[],content:payload.text.content,clientId:payload.clientmsgid});
    submitting=true;
    if(!await p.commitSubmitting(job,batch)){submitting=false;if(await p.defer?.(job))return 'deferred';await p.finish(job,'blocked');return 'blocked';}
    const receipt=await p.submit(job,batch);
    if(typeof receipt!=='string'||!/^\d{1,20}$/.test(receipt)||BigInt(receipt)<=0n)throw new Error('invalid_mass_receipt');
    await p.finish(job,'submitted',receipt);return 'submitted';
  }catch{
    // Includes failures persisting a receipt after a successful HTTP request.
    // Never submit again under a new clientmsgid on an ambiguous outcome.
    const state=submitting?'uncertain':'failed';
    await p.finish(job,state);return state;
  }
}
