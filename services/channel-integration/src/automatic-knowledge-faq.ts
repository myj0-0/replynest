import {createHash} from 'node:crypto';
import {AUTOMATIC_KNOWLEDGE_EVIDENCE_VERSION,automaticQuestionTopic,automaticTextRisks,compactAutomaticText,type AutomaticAnswerEvidence} from './automatic-reception-evidence.js';
/** Conservative semantic families, not merely matching the word "shipping".
 * New product families must add positive AND negative tests before opening.
 * Unknown modifiers (cold chain, express, international, etc.) are not erased.
 */
export function automaticFaqIntent(question:string):string|null{
 if(automaticTextRisks(question).length)return null;
 let q=compactAutomaticText(question);
 q=q.replace(/^(您好|你好|请问|想问一下|想问|麻烦问一下|请告诉我|请告知)/u,'').replace(/(呢|呀|啊|吗|谢谢)$/u,'');
 if(/^(一般|通常|正常)?(多久|几天|多长时间|什么时候)(可以|会|能|才)?(发货|出库)$/u.test(q)||
  /^(一般|通常|正常)?(发货|出库)(一般|通常)?(要|需要)?(多久|几天|多长时间)$/u.test(q)||
  /^(howlong(doesshippingtake|toship)|whendoyouship)$/u.test(q))return 'shipping_lead_time';
 if(/^(营业时间|工作时间|客服时间)(是|为|在)?(什么|多久|几点|什么时候)?$/u.test(q))return 'opening_hours';
 if(/^(几点|什么时候)(营业|开门)$/u.test(q))return 'opening_start';
 if(/^(几点|什么时候)(结束营业|关门)$/u.test(q))return 'opening_end';
 if(/^(联系方式|联系电话|邮箱|官网)(是|为|有)?(什么|多少|哪个)?$/u.test(q))return q.startsWith('联系电话')?'contact_phone':q.startsWith('邮箱')?'contact_email':q.startsWith('官网')?'contact_website':'contact_information';
 return null;
}
export function equivalentAutomaticFaqQuestions(a:string,b:string){
 if(compactAutomaticText(a)===compactAutomaticText(b))return true;
 const intent=automaticFaqIntent(a);return intent!==null&&intent===automaticFaqIntent(b);
}
export type PublishedKnowledgeFaq={tenantId:string;documentId:string;version:number;content:string;validFrom:string;validUntil:string};
/** Extract only explicit question/answer pairs from a bounded, published safe document.
 * The model may copy the server-selected answer, not invent an answer from arbitrary prose.
 * Ingestion/indexing/draft/version checks are the caller's SQL responsibility.
 */
export function publishedKnowledgeFaqAnswers(doc:PublishedKnowledgeFaq,question:string):AutomaticAnswerEvidence[]{
 if(typeof doc.content!=='string'||doc.content.length>12000||!Number.isInteger(doc.version)||doc.version<1)return [];
 const lines=doc.content.split(/\r?\n/),out:AutomaticAnswerEvidence[]=[];
 // Do not throw away document-wide qualifiers such as "overseas orders only".
 // Unstructured preambles require human review until scoped context is supported.
 const first=lines.findIndex(line=>line.trim().length>0);
 if(first<0||!/^(?:Q|问|问题)\s*[:：]/iu.test(lines[first].trim()))return [];
 // The 21st result is an overflow sentinel, not a silently dropped conflict.
 for(let i=0;i<lines.length&&out.length<21;i++){
  const q=/^(?:Q|问|问题)\s*[:：]\s*(.{2,1000})$/iu.exec(lines[i].trim());
  if(!q)continue;
  const next=lines[i+1]?.trim()??'',a=/^(?:A|答|回答)\s*[:：]\s*(.{1,2000})$/iu.exec(next);
  if(!a||!equivalentAutomaticFaqQuestions(q[1],question)||automaticTextRisks(a[1]).length)continue;
  const topic=automaticQuestionTopic(q[1]);if(!topic||topic!==automaticQuestionTopic(question))continue;
  // A two-line prefix must not discard later restrictions, prices or guarantees.
  // Only explicit next questions delimit an answer; other nonempty lines remain
  // part of the selected source, including headings/code/instructions.
  const body=[a[1]];
  let end=i+2;
  while(end<lines.length&&!/^(?:Q|问|问题)\s*[:：]/iu.test(lines[end].trim()))body.push(lines[end++]);
  const answer=body.join('\n').trim();
  if(answer.length>2000||automaticTextRisks(answer).length)continue;
  out.push({answerId:'knowledge:'+doc.documentId+':'+createHash('sha256').update(q[1]+'\n'+answer).digest('hex'),
   tenantId:doc.tenantId,documentId:doc.documentId,documentVersion:doc.version,currentDocumentVersion:doc.version,topic,answerText:answer,
   keywords:topic==='shipping_information'?['发货','出库','ship']:topic==='opening_hours'?['营业','工作','客服','时间','开门','关门']:topic==='contact_information'?['联系','邮箱','官网']:['使用','安装'],
   questionTexts:[q[1]],approved:true,approvalVersion:AUTOMATIC_KNOWLEDGE_EVIDENCE_VERSION,sourceKind:'published_knowledge_faq',
   requiresHumanApproval:false,active:true,sourceContainsAnswer:true,validFrom:doc.validFrom,validUntil:doc.validUntil});
 }
 return out;
}
