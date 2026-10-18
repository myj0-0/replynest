/** Optional server-only durable-delay wiring. Registration requires an explicit
 * verified release gate. No schema installation or implicit sends here. */
import type {Pool} from 'pg';
import {automaticReplyDecision} from './automatic-reply-policy.js';
import {resumeStoredAutomaticReception,type AutomaticReceptionAdapter} from './automatic-reception-runtime.js';
import {finishAutomaticReception,type AutomaticReceptionLease} from './automatic-reception-store.js';
import {persistAutomaticReplyWait,claimDueAutomaticReply,finishAutomaticReplyWait,expireAutomaticReplyWaits} from './automatic-reply-wait-store.js';
import type {AutomaticPresentationOptions} from './reception-automatic-presentation.js';
import type {ReceptionDraft} from './reception-executor.js';
type Db=Pick<Pool,'query'|'connect'>;
type Options={enabled?:()=>boolean;family:'web'|'wechat';adapter:AutomaticReceptionAdapter;
 presentationOptions:AutomaticPresentationOptions;
 /** Canonical question from the adapter's freshly verified native snapshot. */
 question(l:AutomaticReceptionLease):Promise<string|null>;
 /** Persisted preparation + authorized history recheck, outside SQL locks. */
 currentPresentation(l:AutomaticReceptionLease,q:string):Promise<boolean>};
export type AutomaticReplyWaitPresentation=Pick<Options,'presentationOptions'|'currentPresentation'>;
export function createAutomaticReplyWaitRuntime(db:Db,o:Options){
 if(!['web','wechat'].includes(o.family))throw Error('invalid_reply_wait_family');
 if(!o.presentationOptions||typeof o.presentationOptions.enabled!=='function'||typeof o.currentPresentation!=='function'||typeof o.question!=='function')
  throw Error('reply_wait_presentation_ports_required');
 const enabled=o.enabled??(()=>false);let stopped=false,active:Promise<number>|null=null;
 const live=()=>!stopped&&enabled()&&o.adapter.enabled()&&!!o.presentationOptions.enabled?.();
 const matches=(l:AutomaticReceptionLease)=>o.family==='web'?l.channel==='web_chat':['wechat_official_account','shared_wechat'].includes(l.channel);
 const defer=async(l:AutomaticReceptionLease,d:ReceptionDraft)=>{
  // This port is only passed under an explicit release gate. Turning it off
  // after generation cancels that answer, never bypasses its wait/guard.
  if(!live()||!matches(l))throw Error('reply_wait_unavailable');
  const q=await o.question(l);
  if(!q||!await o.currentPresentation(l,q)||!live())throw Error('reply_wait_presentation_changed');
  return persistAutomaticReplyWait(db,l,d,q,o.presentationOptions);
 };
 async function one(){
   if(!live())return 0;
   const claim=await claimDueAutomaticReply(db,o.family);if(!claim)return 0;
   // Claim is already durable. Any subsequent failure must never regenerate or
   // requeue; native/provider final uncertainty barriers remain authoritative.
   const l=claim.lease;
   let state:'skipped'|'draft'|'accepted'|'uncertain'|'failed';
   try{
    const facts=await o.adapter.facts(l); // also repopulates native WeakMap fences after restart
    const q=await o.question(l);
    if(!live()||automaticReplyDecision(facts).action==='skip'||!q||!await o.currentPresentation(l,q)){
     state='skipped';await finishAutomaticReception(db,l,state,'reply_wait_conditions_changed');
    }else{
     const result=await resumeStoredAutomaticReception(db,l,claim.draft,o.adapter);
     if(result==='waiting')throw Error('reply_wait_recursive_dispatch');
     state=result;
    }
   }catch{
    // Never overwrite accepted/submitting/uncertain with a guessed failure.
    // Store reconciliation below only succeeds if the actual job is terminal.
    const row=(await db.query(`SELECT state FROM automatic_reception_jobs WHERE tenant_id=$1 AND job_id=$2 AND worker_token=$3`,
     [l.tenantId,l.jobId,l.workerToken])).rows[0];
    if(row?.state==='processing'){state='failed';await finishAutomaticReception(db,l,state,'reply_wait_validation_failed');}
    else if(['draft','skipped','accepted','uncertain','failed'].includes(row?.state))state=row.state;
    else throw Error('reply_wait_dispatch_review_required');
   }
   await finishAutomaticReplyWait(db,claim,state);return 1;
 }
 async function run(){
  if(!live())return 0;
  await expireAutomaticReplyWaits(db);
  // Two bounded concurrent dispatches per channel family, separate from model
  // batches. Both settle before shutdown; one rejection cannot abandon its peer.
  const results=await Promise.allSettled([one(),one()]);
  if(results.some(r=>r.status==='rejected'))throw Error('reply_wait_dispatch_review_required');
  return results.reduce((n,r)=>n+(r.status==='fulfilled'?r.value:0),0);
 }
 return {defer,tick:()=>{
  if(active||!live())return Promise.resolve(0);
  const p=run();active=p;void p.finally(()=>{if(active===p)active=null;}).catch(()=>{});return p;
 },stop:async()=>{stopped=true;await active;}};
}
