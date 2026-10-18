/** Bounded, pure policies for a future separately authorized history reader.
 * NOT a history endpoint or grant. Signed native/customer/tenant binding and
 * consent must be resolved by trusted adapters before any production reads.
 */
import {createHash} from 'node:crypto';
import {receptionReplyCharacters,type ReceptionTone} from './reception-presentation.js';
export const RECEPTION_HISTORY_DISCLOSURES=Object.freeze({
 style:'reception-history-style-v1',context:'reception-history-context-v1',knowledgeDraft:'reception-history-knowledge-draft-v1'
});
export type ReceptionHistoryPurpose=keyof typeof RECEPTION_HISTORY_DISCLOSURES;
export type ReceptionHistoryScope=Readonly<{tenantId:string;accountId:string;purpose:ReceptionHistoryPurpose;customerId?:string}>;
export type ReceptionHistoryMessage=Readonly<{
 tenantId:string;accountId:string;customerId:string;conversationId:string;messageId:string;createdAtMs:number;
 direction:'incoming'|'outgoing';authorKind:'customer'|'human'|'ai'|'system';private:boolean;deleted:boolean;text:string;
}>;
export const RECEPTION_HISTORY_LIMITS=Object.freeze({lookbackDays:30,pageRows:200,messages:80,conversations:20,characters:16000,messageCharacters:2000});
const validId=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(v);
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
/** Fail closed on adapter isolation drift. No truncation of individual messages:
 * an incomplete historical condition isn't suitable for drafting knowledge.
 * Read adapters must enforce these bounds IN SQL too, not fetch the whole tenant.
 */
export function selectReceptionHistorySample(scope:ReceptionHistoryScope,rows:readonly ReceptionHistoryMessage[],nowMs:number):readonly ReceptionHistoryMessage[] {
 if(!scope||!validId(scope.tenantId)||!validId(scope.accountId)||!Object.hasOwn(RECEPTION_HISTORY_DISCLOSURES,scope.purpose)||
  (scope.customerId!==undefined&&!validId(scope.customerId))||(scope.purpose==='context'&&!scope.customerId)||
  !Number.isSafeInteger(nowMs)||nowMs<0||!Array.isArray(rows)||rows.length>RECEPTION_HISTORY_LIMITS.pageRows)
  throw Error('invalid_reception_history_scope');
 const candidates:ReceptionHistoryMessage[]=[];const keys=new Set<string>();
 for(const row of rows){
  if(!row||row.tenantId!==scope.tenantId||row.accountId!==scope.accountId||
   !validId(row.customerId)||!validId(row.conversationId)||!validId(row.messageId)||
   (scope.customerId!==undefined&&row.customerId!==scope.customerId))throw Error('reception_history_binding_mismatch');
  if(typeof row.private!=='boolean'||typeof row.deleted!=='boolean'||!['incoming','outgoing'].includes(row.direction)||
   !['customer','human','ai','system'].includes(row.authorKind)||typeof row.text!=='string'||
   !Number.isSafeInteger(row.createdAtMs)||row.createdAtMs<0||row.createdAtMs>nowMs)throw Error('invalid_reception_history_message');
  const key=row.messageId;if(keys.has(key))throw Error('duplicate_reception_history_message');keys.add(key);
  if(row.private||row.deleted||row.authorKind==='ai'||row.authorKind==='system'||
   row.createdAtMs<nowMs-RECEPTION_HISTORY_LIMITS.lookbackDays*86400000||!row.text.trim()||
   row.text.length>RECEPTION_HISTORY_LIMITS.messageCharacters)continue;
  const human=row.direction==='outgoing'&&row.authorKind==='human';
  const customer=row.direction==='incoming'&&row.authorKind==='customer';
  if(!human&&!(scope.purpose!=='style'&&customer))continue;
  candidates.push(row);
 }
 candidates.sort((a,b)=>b.createdAtMs-a.createdAtMs||a.messageId.localeCompare(b.messageId,'en'));
 const result:ReceptionHistoryMessage[]=[],conversations=new Set<string>();let characters=0;
 for(const row of candidates){
  if(result.length>=RECEPTION_HISTORY_LIMITS.messages)break;
  if(!conversations.has(row.conversationId)&&conversations.size>=RECEPTION_HISTORY_LIMITS.conversations)continue;
  if(characters+row.text.length>RECEPTION_HISTORY_LIMITS.characters)continue;
  conversations.add(row.conversationId);characters+=row.text.length;result.push(Object.freeze({
   tenantId:row.tenantId,accountId:row.accountId,customerId:row.customerId,conversationId:row.conversationId,messageId:row.messageId,
   createdAtMs:row.createdAtMs,direction:row.direction,authorKind:row.authorKind,private:row.private,deleted:row.deleted,text:row.text
  }));
 }
 return Object.freeze(result);
}
export type ReceptionLearnedStyle=Readonly<{
 status:'insufficient_history'|'suggestion';tone:ReceptionTone;sampleMessages:number;sampleConversations:number;
 medianReplyCharacters:number;politeGreetingRate:number;friendlyMarkerRate:number;emojiRate:number;
}>;
/** Learn only aggregate presentation signals. No text, agent/customer identifiers,
 * facts, quotes or historical instructions are exported into a style profile.
 * Multiple agents contribute message-frequency votes; repeated scans aren't votes.
 * This suggestion never changes a tenant's selected preset on its own.
 */
export function suggestReceptionStyle(scope:ReceptionHistoryScope,rows:readonly ReceptionHistoryMessage[],nowMs:number):ReceptionLearnedStyle {
 if(scope.purpose!=='style')throw Error('reception_style_scope_required');
 const sample=selectReceptionHistorySample(scope,rows,nowMs),conversations=new Set(sample.map(m=>m.conversationId));
 const lengths=sample.map(m=>receptionReplyCharacters(m.text)).sort((a,b)=>a-b);
 const median=lengths.length?lengths.length%2?lengths[(lengths.length-1)/2]:(lengths[lengths.length/2-1]+lengths[lengths.length/2])/2:0;
 const rate=(pattern:RegExp)=>sample.length?sample.filter(m=>pattern.test(m.text)).length/sample.length:0;
 const politeGreetingRate=rate(/^\s*(您好|你好|您好呀|hello\b|hi\b)/iu),friendlyMarkerRate=rate(/亲亲|亲，|哦[~～。！!]?|呀[~～。！!]?/u),emojiRate=rate(/\p{Extended_Pictographic}|\(\^v\^\)/u);
 const sufficient=sample.length>=8&&conversations.size>=3;
 const tone:ReceptionTone=!sufficient?'neutral':friendlyMarkerRate>=0.5?'friendly_detailed':median<=40&&politeGreetingRate<0.5&&emojiRate<0.25?'concise':'neutral';
 return Object.freeze({status:sufficient?'suggestion':'insufficient_history',tone,sampleMessages:sample.length,sampleConversations:conversations.size,
  medianReplyCharacters:median,politeGreetingRate,friendlyMarkerRate,emojiRate});
}
export type HistoricalKnowledgeProposal=Readonly<{question:string;answer:string;sourceMessageIds:readonly string[]}>;
export type HistoricalKnowledgeDraft=Readonly<{
 question:string;answer:string;sourceMessageIds:readonly string[];sourceDigest:string;
 state:'draft';requiresTenantReview:true;automaticUseAllowed:false;
}>;
/** Historical statements are NOT verified KB facts. Both a customer question and
 * human answer must be traceable in the same conversation/customer. A model
 * cannot set approved/indexed/send flags. Persistence must keep a normal KB
 * draft until a human edits, confirms and explicitly publishes it.
 */
export function createHistoricalKnowledgeDraft(scope:ReceptionHistoryScope,rows:readonly ReceptionHistoryMessage[],nowMs:number,proposal:unknown):HistoricalKnowledgeDraft {
 if(scope.purpose!=='knowledgeDraft')throw Error('reception_knowledge_draft_scope_required');
 const sample=selectReceptionHistorySample(scope,rows,nowMs);
 if(!proposal||typeof proposal!=='object'||Array.isArray(proposal))throw Error('invalid_historical_knowledge_proposal');
 const p=proposal as Record<string,unknown>;
 if(Object.keys(p).sort().join(',')!=='answer,question,sourceMessageIds'||typeof p.question!=='string'||!p.question.trim()||p.question.length>1000||
  typeof p.answer!=='string'||!p.answer.trim()||p.answer.length>4000||!Array.isArray(p.sourceMessageIds)||p.sourceMessageIds.length<2||p.sourceMessageIds.length>8||
  p.sourceMessageIds.some(id=>!validId(id))||new Set(p.sourceMessageIds).size!==p.sourceMessageIds.length)throw Error('invalid_historical_knowledge_proposal');
 const sources=p.sourceMessageIds.map(id=>sample.find(row=>row.messageId===id));
 if(sources.some(row=>!row))throw Error('historical_knowledge_sources_unavailable');
 const messages=sources as ReceptionHistoryMessage[],first=messages[0];
 const customerQuestions=messages.filter(row=>row.authorKind==='customer'&&row.direction==='incoming');
 const humanAnswers=messages.filter(row=>row.authorKind==='human'&&row.direction==='outgoing');
 if(messages.some(row=>row.conversationId!==first.conversationId||row.customerId!==first.customerId)||
  !customerQuestions.some(q=>humanAnswers.some(a=>a.createdAtMs>=q.createdAtMs)))throw Error('historical_knowledge_pair_required');
 // Canonical source evidence digest, not a validity/approval score. Private raw
 // source text remains in its native store; no transcript in the returned draft.
 const sourceDigest=hash(JSON.stringify([...messages].sort((a,b)=>a.messageId.localeCompare(b.messageId,'en')).map(row=>({
  tenant:row.tenantId,account:row.accountId,customer:row.customerId,conversation:row.conversationId,message:row.messageId,at:row.createdAtMs,textHash:hash(row.text)
 }))));
 return Object.freeze({question:p.question.trim(),answer:p.answer.trim(),sourceMessageIds:Object.freeze([...p.sourceMessageIds] as string[]),
  sourceDigest,state:'draft',requiresTenantReview:true,automaticUseAllowed:false});
}
