import type {Pool,PoolClient} from 'pg';
import {automaticReplyDecision,type AutomaticReplyFacts} from './automatic-reply-policy.js';
import {executeReception,dispatchPreparedReception,validReceptionAssessment,type ReceptionPorts,type ReceptionAssessment,type ReceptionDraft,type ReceptionJob} from './reception-executor.js';
import {automaticGrantCurrent,claimAutomaticReception,commitAutomaticSubmitting,finishAutomaticReception,saveAutomaticDraft,
 type AutomaticReceptionLease,type AutomaticReceipt} from './automatic-reception-store.js';

export type AutomaticSubmission={outcome:'accepted';receipt:AutomaticReceipt}|{outcome:'rejected'|'uncertain'};
export type AutomaticReceptionAdapter={
 enabled():boolean;
 facts(l:AutomaticReceptionLease):Promise<AutomaticReplyFacts>;
 generate(l:AutomaticReceptionLease):Promise<ReceptionDraft>;
 /** Available only from the adapter's freshly verified native snapshot. No
  * model/job payload fallback; durable waits use this after facts() refresh. */
 canonicalQuestion?(l:AutomaticReceptionLease):Promise<string|null>;
 /** Trusted server evidence/risk check; not a model-supplied score. */
 assess(l:AutomaticReceptionLease,d:ReceptionDraft):Promise<ReceptionAssessment>;
 /** Recheck grant, latest incoming, human takeover, account/channel/customer binding,
  * reply window, shared active merchant and limits under consistent locks. No sending here.
  */
 authorize(db:PoolClient,l:AutomaticReceptionLease,d:ReceptionDraft):Promise<{facts:AutomaticReplyFacts;assessment:ReceptionAssessment}>;
 /** Called after ROLLBACK releases locks, so denial audit does not deadlock on the job FK. */
 recordAuthorizationDenial?(db:PoolClient,l:AutomaticReceptionLease,assessment:ReceptionAssessment):Promise<void>;
 /** At most one attempt; receipt means provider acknowledgement, not delivery or reading. */
 submit(l:AutomaticReceptionLease,d:ReceptionDraft):Promise<AutomaticSubmission>;
};
function eligible(f:AutomaticReplyFacts,d:ReceptionDraft,a:ReceptionAssessment){
 if(!validReceptionAssessment(a))return false;
 return automaticReplyDecision({...f,generated:d.generated,fallback:d.fallback,
  requiresHumanApproval:f.requiresHumanApproval||d.requiresHumanApproval||a.requiresHumanApproval,
  evidenceCandidate:a.evidenceCandidate,confidencePercent:a.confidencePercent}).action==='send';
}
/** Persistence wiring only: deliberately no production ingress, migration or poller registration. */
function storedDispatchPorts(db:Pick<Pool,'query'|'connect'>,getLease:()=>AutomaticReceptionLease,a:AutomaticReceptionAdapter,
 defer?: (l:AutomaticReceptionLease,d:ReceptionDraft)=>Promise<boolean>):Pick<ReceptionPorts,'facts'|'assess'|'commitSending'|'send'|'finish'|'defer'> {
 let receipt:AutomaticReceipt|undefined;
 return {
  facts:async()=>{
   const lease=getLease(),f=await a.facts(lease);
   const current=await automaticGrantCurrent(db,lease);
   return {...f,executorAvailable:a.enabled()&&f.executorAvailable,
    consentVersion:current?f.consentVersion:null,sendConsentVersion:current?lease.consentVersion:null};
  },
  ...(defer?{defer:async(_:ReceptionJob,d:ReceptionDraft)=>defer(getLease(),d)}:{}),
  assess:async(_,d)=>a.assess(getLease(),d),
  commitSending:async(_,d)=>{
   const lease=getLease();
   const client=await db.connect();
   try{
    await client.query('BEGIN');
    const check=await a.authorize(client,lease,d);
    if(!a.enabled()||!eligible(check.facts,d,check.assessment)){
     await client.query('ROLLBACK');await a.recordAuthorizationDenial?.(client,lease,check.assessment);return false;
    }
    const committed=await commitAutomaticSubmitting(client,lease,d);
    if(!committed){await client.query('ROLLBACK');await a.recordAuthorizationDenial?.(client,lease,check.assessment);return false;}
    await client.query('COMMIT');return committed;
   }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
   finally{client.release();}
  },
  send:async(_,d)=>{
   if(!a.enabled())throw Error('automatic_execution_disabled_after_barrier');
   const result=await a.submit(getLease(),d);
   if(result.outcome==='accepted'){
    // The store will reject malformed receipts. Freeze/copy before a future adapter mutates it.
    receipt=Object.freeze({...result.receipt});
   }
   return result.outcome;
  },
  finish:async(_,state,reason)=>finishAutomaticReception(db,getLease(),state,reason,receipt),
 };
}
/** Default path is unchanged. A release must explicitly supply the durable
 * defer port; tenant settings or model output cannot register it. */
export async function executeStoredAutomaticReception(db:Pick<Pool,'query'|'connect'>,j:ReceptionJob,a:AutomaticReceptionAdapter,
 options:{defer?:(l:AutomaticReceptionLease,d:ReceptionDraft)=>Promise<boolean>}={}){
 if(!a.enabled())return 'disabled' as const;
 let lease:AutomaticReceptionLease|null=null;
 return executeReception(j,{
  ...storedDispatchPorts(db,()=>lease!,a,options.defer),
  claim:async()=>{lease=await claimAutomaticReception(db,j);return !!lease;},
  generate:async()=>a.generate(lease!),
  saveDraft:async(_,d)=>saveAutomaticDraft(db,lease!,d),
 });
}
/** Internal durable dispatcher only, never an HTTP action. It cannot claim a
 * generation job, regenerate, save/alter an answer, or charge the model again. */
export async function resumeStoredAutomaticReception(db:Pick<Pool,'query'|'connect'>,l:AutomaticReceptionLease,d:ReceptionDraft,a:AutomaticReceptionAdapter){
 return dispatchPreparedReception(l,d,storedDispatchPorts(db,()=>l,a));
}
