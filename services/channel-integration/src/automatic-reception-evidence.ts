import {createHash} from 'node:crypto';
import type {ReceptionAssessment} from './reception-executor.js';
import {equivalentAutomaticFaqQuestions} from './automatic-knowledge-faq.js';

export const AUTOMATIC_EVIDENCE_VERSION='approved-exact-answer-v1';
export const AUTOMATIC_KNOWLEDGE_EVIDENCE_VERSION='published-knowledge-faq-v1';
export const AUTOMATIC_SEMANTIC_EVIDENCE_VERSION='published-knowledge-semantic-v1';
export const AUTOMATIC_TOPICS=['opening_hours','shipping_information','contact_information','usage_instructions'] as const;
export type AutomaticTopic=typeof AUTOMATIC_TOPICS[number];
export type AutomaticRisk='refund_or_money'|'binding_commitment'|'identity_or_credentials'|'regulated_or_safety'|'transaction_specific'|'instruction_override';
const riskPatterns:Array<[AutomaticRisk,RegExp]>=[
 ['refund_or_money',/退|赔偿|金额|价格|价钱|费用|折扣|优惠|付款|支付|充值|转账|收款|余额|现金|[¥$€£%]|人民币|美元|refund|discount|payment|price|cost|cash|charge|fee|withdraw|reimburse|\d+(?:元|块|yuan|rmb|usd)/iu],
 ['binding_commitment',/承诺|保证|确保|必定|一定|肯定|赔付|guarantee|promise|definitely|certainly|warranty/iu],
 ['identity_or_credentials',/身份证|银行卡|验证码|密码|私密|个人信息|证件|登录凭据|password|verificationcode|secret|token|credential|bankaccount|socialsecurity/iu],
 ['regulated_or_safety',/诊断|处方|剂量|怀孕|自杀|律师|诉讼|法院|人身伤害|suicide|lawsuit|diagnos|prescription|dosage|pregnan|violence/iu],
 ['transaction_specific',/订单|单号|我的包裹|我的物流|查不到|未收到|未发货|已经发货|order|trackingnumber|shipmentstatus|whereismy|notreceived/iu],
 ['instruction_override',/忽略.{0,12}(规则|指令|系统)|绕过|越权|系统提示词|提示词注入|ignore.{0,16}(instruction|rule|system)|systemprompt|jailbreak|javascript:|data:text|datatext/iu]
];
/** NFKC + compact form catches split/full-width risk words. It is not semantic understanding. */
export function compactAutomaticText(text:string){
 return text.normalize('NFKC').toLowerCase().replace(/[\p{C}\p{Z}\s\p{P}]/gu,'');
}
export function automaticTextRisks(text:string):AutomaticRisk[]{
 const normalized=compactAutomaticText(text);
 return riskPatterns.filter(([,p])=>p.test(normalized)||p.test(text.normalize('NFKC').toLowerCase())).map(([risk])=>risk);
}
const topicPatterns:Array<[AutomaticTopic,RegExp]>=[
 ['opening_hours',/营业|办公时间|工作时间|客服时间|开门|关门|openinghours|businesshours|officehours|when.*open|when.*close/iu],
 ['shipping_information',/发货|出库|配送|物流|shipping|whendoyouship|howlongtoship|delivery|dispatch/iu],
 ['contact_information',/联系方式|联系电话|邮箱|官网|联系你们|contact|email|website/iu],
 ['usage_instructions',/使用方法|使用说明|怎么使用|如何使用|安装|howtouse|userguide|installation|install/iu]
];
export function automaticQuestionTopic(question:string):AutomaticTopic|null {
 const normalized=compactAutomaticText(question);
 const topics=topicPatterns.filter(([,p])=>p.test(normalized)).map(([topic])=>topic);
 return topics.length===1?topics[0]:null;
}
export type AutomaticAnswerEvidence={
 sourceKind?:'published_knowledge_faq';
 answerId:string;tenantId:string;documentId:string;documentVersion:number;currentDocumentVersion:number;
 topic:AutomaticTopic;answerText:string;keywords:string[];questionTexts:string[];approved:boolean;approvalVersion:string;
 requiresHumanApproval:boolean;active:boolean;sourceContainsAnswer:boolean;validFrom:string;validUntil:string;
};
export type AutomaticPolicyEvidence={
 tenantId:string;policyId:string;priority:number;scope:Record<string,unknown>;conditions:Record<string,unknown>;
 decision:Record<string,unknown>;requiresHumanApproval:boolean;forbiddenActions:string[];timeBasis:string;
};
export type AutomaticEvidenceAssessment=ReceptionAssessment & {
 version:typeof AUTOMATIC_EVIDENCE_VERSION|typeof AUTOMATIC_KNOWLEDGE_EVIDENCE_VERSION|typeof AUTOMATIC_SEMANTIC_EVIDENCE_VERSION;reason:string;risks:AutomaticRisk[];
 answerIds:string[];documentIds:string[];documentVersions:number[];policyIds:string[];replyHash:string;
 evidenceRevision?:string;
};
function canonicalJson(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalJson((value as Record<string,unknown>)[k])).join(',')+'}';
 return JSON.stringify(value);
}
/** Shared policy gate: neither FAQ matching nor semantic generation may reinterpret
 * unknown business context, override required approval or pick a conflicting rule. */
export function automaticPolicyDecision(input:{tenantId:string;channel:string;policies:AutomaticPolicyEvidence[];policyOverflow?:boolean}){
 const policyIds:string[]=[];
 const deny=(reason:string)=>({allowed:false,reason,policyIds});
 if(!Array.isArray(input.policies)||input.policyOverflow||input.policies.length>100)return deny('evidence_limit_review_required');
 const matched:AutomaticPolicyEvidence[]=[];
 for(const p of input.policies){
  if(p.tenantId!==input.tenantId)return deny('foreign_policy_rejected');
  if(!p.scope||typeof p.scope!=='object'||Array.isArray(p.scope)||!p.conditions||typeof p.conditions!=='object'||Array.isArray(p.conditions)||
   !p.decision||typeof p.decision!=='object'||Array.isArray(p.decision)||!Number.isInteger(p.priority)||typeof p.requiresHumanApproval!=='boolean'||!Array.isArray(p.forbiddenActions)||p.forbiddenActions.some(a=>typeof a!=='string'))return deny('malformed_policy');
  const channels=p.scope.channels;
  if(channels!==undefined&&(!Array.isArray(channels)||channels.some(c=>typeof c!=='string')))return deny('malformed_policy');
  if(Array.isArray(channels)&&channels.length&&!channels.includes(input.channel))continue;
  if(Object.keys(p.scope).some(k=>k!=='channels')||Object.keys(p.conditions).length||!['request_time','action_time'].includes(p.timeBasis))return deny('policy_context_required');
  matched.push(p);policyIds.push(p.policyId);
 }
 if(matched.some(p=>p.requiresHumanApproval||p.forbiddenActions.some(a=>['*','automatic_reply','automatic_send','send_message','message.send','send_to_customer'].includes(a))))return deny('policy_human_required');
 const highest=Math.max(...matched.map(p=>p.priority));
 if(new Set(matched.filter(p=>p.priority===highest).map(p=>canonicalJson(p.decision))).size>1)return deny('policy_conflict');
 if(matched.some(p=>Object.keys(p.decision).length))return deny('policy_context_required');
 return {allowed:true,reason:'policy_allowed',policyIds};
}
/** Server-selected metadata only. No model citation IDs, history, score or tool claims are accepted.
 * A 95 is a readiness rule score for an approved exact answer, not a 95% correctness probability.
 */
export function assessAutomaticEvidence(input:{tenantId:string;channel:string;question:string;reply:string;now:Date;
 sources:AutomaticAnswerEvidence[];policies:AutomaticPolicyEvidence[];sourceOverflow?:boolean;policyOverflow?:boolean}):AutomaticEvidenceAssessment {
 const result:AutomaticEvidenceAssessment={requiresHumanApproval:true,evidenceCandidate:false,confidencePercent:0,version:AUTOMATIC_EVIDENCE_VERSION,
  reason:'evidence_unavailable',risks:[],answerIds:[],documentIds:[],documentVersions:[],policyIds:[],
  replyHash:createHash('sha256').update(typeof input.reply==='string'?input.reply:'').digest('hex')};
 const deny=(reason:string)=>({...result,reason});
 if(typeof input.question!=='string'||typeof input.reply!=='string'||!input.question.trim()||!input.reply.trim()||input.question.length>4000||input.reply.length>4000||
  !Number.isFinite(input.now.getTime())||!Array.isArray(input.sources)||!Array.isArray(input.policies))return deny('invalid_evidence_input');
 result.risks=[...new Set([...automaticTextRisks(input.question),...automaticTextRisks(input.reply)])];
 if(result.risks.length)return deny('high_risk_human_required');
 const topic=automaticQuestionTopic(input.question);
 if(!topic)return deny('unsupported_or_ambiguous_topic');
 if(input.sourceOverflow||input.policyOverflow||input.sources.length>20||input.policies.length>100)return deny('evidence_limit_review_required');
 if(input.sources.some(s=>s.tenantId!==input.tenantId))return deny('foreign_source_rejected');
 const policy=automaticPolicyDecision(input);result.policyIds=policy.policyIds;
 if(!policy.allowed)return deny(policy.reason);
 const now=input.now.getTime(),question=compactAutomaticText(input.question);
 const eligible=input.sources.filter(s=>s.tenantId===input.tenantId&&s.topic===topic&&s.approved===true&&s.active===true&&
  s.requiresHumanApproval===false&&(s.sourceKind==='published_knowledge_faq'?s.approvalVersion===AUTOMATIC_KNOWLEDGE_EVIDENCE_VERSION:s.approvalVersion===AUTOMATIC_EVIDENCE_VERSION)&&s.sourceContainsAnswer===true&&
  Number.isInteger(s.documentVersion)&&s.documentVersion>0&&s.documentVersion===s.currentDocumentVersion&&
  typeof s.answerText==='string'&&s.answerText.trim()&&s.answerText.length<=4000&&Array.isArray(s.keywords)&&s.keywords.length>0&&s.keywords.length<=12&&
  s.keywords.every(k=>typeof k==='string'&&compactAutomaticText(k).length>=2&&k.length<=40)&&
  s.keywords.some(k=>question.includes(compactAutomaticText(k)))&&
  Array.isArray(s.questionTexts)&&s.questionTexts.length>0&&s.questionTexts.length<=20&&
  s.questionTexts.every(q=>typeof q==='string'&&q.trim().length>=2&&q.length<=1000)&&
  s.questionTexts.some(q=>s.sourceKind==='published_knowledge_faq'?equivalentAutomaticFaqQuestions(q,input.question):question===compactAutomaticText(q))&&
  Number.isFinite(Date.parse(s.validFrom))&&Number.isFinite(Date.parse(s.validUntil))&&Date.parse(s.validFrom)<=now&&now<Date.parse(s.validUntil));
 if(!eligible.length)return deny('approved_current_answer_required');
 if(new Set(eligible.map(s=>s.answerText.trim())).size!==1)return deny('answer_conflict');
 const answer=eligible[0];
 if(input.reply.trim()!==answer.answerText.trim())return deny('reply_not_exactly_grounded');
 result.answerIds=eligible.map(s=>s.answerId);result.documentIds=eligible.map(s=>s.documentId);result.documentVersions=eligible.map(s=>s.documentVersion);
 const knowledge=eligible.some(s=>s.sourceKind==='published_knowledge_faq');
 return {...result,version:knowledge?AUTOMATIC_KNOWLEDGE_EVIDENCE_VERSION:AUTOMATIC_EVIDENCE_VERSION,
  requiresHumanApproval:false,evidenceCandidate:true,confidencePercent:95,reason:knowledge?'knowledge_grounded_faq':'approved_exact_answer'};
}
