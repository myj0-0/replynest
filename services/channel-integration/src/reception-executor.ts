import {automaticReplyDecision,type AutomaticReplyFacts} from './automatic-reply-policy.js';

export type ReceptionJob={tenantId:string;jobId:string;messageId:string};
export type ReceptionDraft={text:string;generated:boolean;fallback:boolean;requiresHumanApproval:boolean;evidenceCandidate:boolean;confidencePercent:number};
export type ReceptionState='skipped'|'draft'|'accepted'|'uncertain'|'failed';
export type ReceptionAssessment={requiresHumanApproval:boolean;evidenceCandidate:boolean;confidencePercent:number};
export function validReceptionAssessment(a:ReceptionAssessment):boolean {
  return !!a&&typeof a.requiresHumanApproval==='boolean'&&typeof a.evidenceCandidate==='boolean'&&
    Number.isFinite(a.confidencePercent)&&a.confidencePercent>=0&&a.confidencePercent<=100;
}
/** Adapters must resolve customers/channels from the job tenant, never from model output.
 * claim() must durably acquire a unique job; commitSending() commits an uncertainty barrier
 * before the external request. Neither uncertain nor accepted jobs may be reclaimed.
 */
export type ReceptionPorts={
  claim(job:ReceptionJob):Promise<boolean>;
  facts(job:ReceptionJob):Promise<AutomaticReplyFacts>;
  generate(job:ReceptionJob):Promise<ReceptionDraft>;
  saveDraft(job:ReceptionJob,draft:ReceptionDraft):Promise<void>;
  /** Server-side evidence/risk assessment. Never copy the model's self-reported score. */
  assess(job:ReceptionJob,draft:ReceptionDraft):Promise<ReceptionAssessment>;
  /** Optional durable handoff AFTER qualification. true means persisted waiting,
   * not sent or delivered. A failed/unknown handoff must never fall through. */
  defer?(job:ReceptionJob,draft:ReceptionDraft):Promise<boolean>;
  commitSending(job:ReceptionJob,draft:ReceptionDraft):Promise<boolean>;
  send(job:ReceptionJob,draft:ReceptionDraft):Promise<'accepted'|'rejected'|'uncertain'>;
  finish(job:ReceptionJob,state:ReceptionState,reason:string):Promise<void>;
};

function frozenDraft(generated:ReceptionDraft):ReceptionDraft {
  if(!generated || typeof generated.text!=='string' || !generated.text.trim() || generated.text.length>4000 ||
    ['generated','fallback','requiresHumanApproval','evidenceCandidate'].some(key=>typeof generated[key as keyof ReceptionDraft]!=='boolean') ||
    !Number.isFinite(generated.confidencePercent) || generated.confidencePercent<0 || generated.confidencePercent>100)throw new Error('invalid_generated_reply');
  return Object.freeze({text:generated.text,generated:generated.generated,fallback:generated.fallback,
    requiresHumanApproval:generated.requiresHumanApproval,evidenceCandidate:generated.evidenceCandidate,confidencePercent:generated.confidencePercent});
}
/** Shared post-generation path. A resumed job has NO claim/generate/save port;
 * only a previously durably claimed frozen answer may enter it. Every send gate
 * is repeated, including facts read after the wait and the native final fence. */
export async function dispatchPreparedReception(job:ReceptionJob,prepared:ReceptionDraft,
 p:Pick<ReceptionPorts,'facts'|'assess'|'commitSending'|'send'|'finish'|'defer'>):Promise<ReceptionState|'waiting'> {
  let sending=false;
  try {
    const draft=frozenDraft(prepared);
    // Opt-out, new incoming messages, human takeover, and quota/channel changes during generation matter.
    const current=await p.facts(job);
    const assessment=await p.assess(job,draft);
    if(!validReceptionAssessment(assessment))throw new Error('invalid_server_assessment');
    const decision=automaticReplyDecision({...current,generated:draft.generated,fallback:draft.fallback,
      requiresHumanApproval:current.requiresHumanApproval||draft.requiresHumanApproval||assessment.requiresHumanApproval,
      evidenceCandidate:assessment.evidenceCandidate,confidencePercent:assessment.confidencePercent});
    if(decision.action!=='send') {
      const state=decision.action==='skip'?'skipped':'draft';
      await p.finish(job,state,decision.reason);return state;
    }
    if(p.defer){
      if(await p.defer(job,draft)!==true)throw Error('invalid_durable_wait_outcome');
      return 'waiting';
    }
    sending=true;
    if(!await p.commitSending(job,draft)){sending=false;await p.finish(job,'skipped','send_authorization_changed');return 'skipped';}
    const result=await p.send(job,draft);
    if(!['accepted','rejected','uncertain'].includes(result))throw new Error('invalid_send_outcome');
    const state=result==='rejected'?'failed':result;
    await p.finish(job,state,result==='rejected'?'provider_rejected':result==='accepted'?'provider_accepted':'send_outcome_uncertain');
    return state;
  }catch{
    const state=sending?'uncertain':'failed';
    await p.finish(job,state,sending?'send_outcome_uncertain':'generation_or_validation_failed');
    return state;
  }
}

/** One bounded generation attempt. A durable wait releases this worker without
 * a timer/sleep and without marking the answer submitted. */
export async function executeReception(job:ReceptionJob,p:ReceptionPorts):Promise<ReceptionState|'duplicate'|'waiting'> {
  if(!await p.claim(job))return 'duplicate';
  let draft:ReceptionDraft;
  try {
    const initial=automaticReplyDecision(await p.facts(job));
    if(initial.action==='skip'){await p.finish(job,'skipped',initial.reason);return 'skipped';}
    draft=frozenDraft(await p.generate(job));
    await p.saveDraft(job,draft);
  }catch{
    await p.finish(job,'failed','generation_or_validation_failed');return 'failed';
  }
  return dispatchPreparedReception(job,draft,p);
}
