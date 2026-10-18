/** Decision-only policy. This module does not generate content or authorize a network send. */
export const AUTOMATIC_REPLY_CONSENT_VERSION = 'automatic-reply-v1';
// Draft consent never authorizes disclosure to a customer.
export const AUTOMATIC_SEND_CONSENT_VERSION = 'automatic-send-v1';
export type AutomaticReplyFacts = {
  executorAvailable:boolean;
  consentVersion:string|null;
  sendConsentVersion:string|null;
  tenantActive:boolean;
  generateEnabled:boolean;
  sendEnabled:boolean;
  latestCustomerMessage:boolean;
  humanResponded:boolean;
  channelReplyable:boolean;
  pointsAvailable:boolean;
  generated:boolean;
  fallback:boolean;
  requiresHumanApproval:boolean;
  evidenceCandidate:boolean;
  confidencePercent:number;
  thresholdPercent:number;
};
export function automaticReplyDecision(f:AutomaticReplyFacts):{action:'skip'|'draft'|'send';reason:string} {
  if(['executorAvailable','tenantActive','generateEnabled','sendEnabled','latestCustomerMessage','humanResponded','channelReplyable','pointsAvailable',
    'generated','fallback','requiresHumanApproval','evidenceCandidate'].some(k=>typeof f[k as keyof AutomaticReplyFacts]!=='boolean'))return {action:'skip',reason:'invalid_automation_facts'};
  if(!f.executorAvailable) return {action:'skip',reason:'executor_unavailable'};
  if(f.consentVersion!==AUTOMATIC_REPLY_CONSENT_VERSION) return {action:'skip',reason:'fresh_consent_required'};
  if(!f.tenantActive || !f.generateEnabled) return {action:'skip',reason:'automation_disabled'};
  if(!f.latestCustomerMessage || f.humanResponded) return {action:'skip',reason:'conversation_changed'};
  if(!f.pointsAvailable) return {action:'skip',reason:'ai_points_exhausted'};
  if(!f.generated || f.fallback || f.requiresHumanApproval || !f.evidenceCandidate) return {action:'draft',reason:'human_review_required'};
  if(!Number.isFinite(f.confidencePercent) || f.confidencePercent<0 || f.confidencePercent>100 || !Number.isInteger(f.thresholdPercent) || f.thresholdPercent<50 || f.thresholdPercent>100 || f.confidencePercent<f.thresholdPercent) return {action:'draft',reason:'confidence_below_threshold'};
  if(!f.channelReplyable) return {action:'draft',reason:'channel_not_replyable'};
  if(!f.sendEnabled) return {action:'draft',reason:'automatic_sending_disabled'};
  if(f.sendConsentVersion!==AUTOMATIC_SEND_CONSENT_VERSION) return {action:'draft',reason:'fresh_send_consent_required'};
  return {action:'send',reason:'eligible'};
}
