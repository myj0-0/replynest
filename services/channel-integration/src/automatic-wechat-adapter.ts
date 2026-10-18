import type {Pool,PoolClient} from 'pg';
import type {AutomaticReplyFacts} from './automatic-reply-policy.js';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import type {ReceptionDraft} from './reception-executor.js';
import {withStoredAutomaticAssessment} from './automatic-reception-grounded-adapter.js';
import {loadAutomaticWeChatTarget,type AutomaticWeChatTarget} from './automatic-wechat-target.js';
import {createAutomaticWeChatNativeClient} from './automatic-wechat-native-client.js';
import type {AutomaticNativeSnapshot} from './automatic-web-native-client.js';
import {createAutomaticWeChatAttemptClaimer} from './automatic-wechat-claim.js';
import {createAutomaticWeChatTransport,automaticWeChatContent} from './automatic-wechat-transport.js';
import {recordAutomaticWeChatOutcome} from './automatic-wechat-outcome.js';
import {persistAutomaticWeChatEnvelope} from './automatic-wechat-history-envelope.js';
import {readPublicAiLabel} from './ai-public-label.js';
type Db=Pick<PoolClient,'query'>;
/** Server-only composition. No timers, implicit credentials, public SDK fallback,
 * manual sender or retries. Native reads NEVER run inside gateway transactions.
 */
export function createAutomaticWeChatAdapter(db:Pick<Pool,'query'|'connect'>,options:{origin:string;secret:string;enabled?:()=>boolean;
 fetcher?:typeof fetch;native?:ReturnType<typeof createAutomaticWeChatNativeClient>;
 generate:(l:AutomaticReceptionLease,question:string)=>Promise<ReceptionDraft>;
 resolveAccessToken:(lease:AutomaticReceptionLease,appId:string,signal:AbortSignal)=>Promise<{appId:string;accessToken:string}>;
}){
 const enabled=options.enabled??(()=>false),native=options.native??createAutomaticWeChatNativeClient(options);
 const verified=new WeakMap<AutomaticReceptionLease,{target:AutomaticWeChatTarget;snapshot:AutomaticNativeSnapshot}>();
 const claim=createAutomaticWeChatAttemptClaimer(db,{enabled,native,
  persistEnvelope:(c,l,target,content)=>persistAutomaticWeChatEnvelope(c,l,target,content,options.secret)});
 async function facts(client:Db,l:AutomaticReceptionLease,locked=false):Promise<AutomaticReplyFacts>{
  if(!enabled()){
   verified.delete(l);
   return {executorAvailable:false,tenantActive:false,consentVersion:null,sendConsentVersion:null,
    generateEnabled:false,sendEnabled:false,pointsAvailable:false,latestCustomerMessage:false,humanResponded:true,
    channelReplyable:false,generated:false,fallback:false,requiresHumanApproval:true,evidenceCandidate:false,
    confidencePercent:0,thresholdPercent:100};
  }
  const target=enabled()?await loadAutomaticWeChatTarget(client,l,locked):null;
  let saved=verified.get(l);
  if(!locked){
   const snapshot=target?await native.snapshot(target.native,l.messageId):null;
   if(target&&snapshot?.current&&!snapshot.human&&snapshot.replyable&&snapshot.fence&&snapshot.question===target.question){
    saved={target,snapshot:structuredClone(snapshot)};verified.set(l,saved);
   }else{saved=undefined;verified.delete(l);}
  }
  const current=!!target&&!!saved&&JSON.stringify(target)===JSON.stringify(saved.target);
  const threshold=(await client.query(`SELECT ai_auto_send_confidence_threshold_percent threshold FROM tenant_ai_settings WHERE tenant_id=$1 ${locked?'FOR SHARE':''}`,[l.tenantId])).rows[0]?.threshold;
  const valid=Number.isInteger(threshold)&&threshold>=50&&threshold<=100;
  // Native pause/newer reply is NOT a missing tenant grant. Preserve the actual authorization
  // facts so the executor reports conversation state rather than demanding fresh consent.
  return {executorAvailable:enabled(),tenantActive:!!target,consentVersion:target?'automatic-reply-v1':null,
   sendConsentVersion:target?l.consentVersion:null,generateEnabled:valid,sendEnabled:valid,pointsAvailable:true,
   latestCustomerMessage:current,humanResponded:!current,channelReplyable:current,generated:false,fallback:false,
   requiresHumanApproval:!valid,evidenceCandidate:false,confidencePercent:0,thresholdPercent:valid?Math.max(95,threshold):100};
 }
 return withStoredAutomaticAssessment(db,{
  enabled,facts:l=>facts(db,l),authorizeFacts:(client,l)=>facts(client,l,true),
  canonicalQuestion:async l=>{const s=verified.get(l)?.snapshot;return enabled()&&s?.current&&!s.human&&s.replyable&&s.fence?s.question:null;},
  question:async(_client,l)=>verified.get(l)?.snapshot.question??'',
  generate:async l=>{
   const v=verified.get(l);if(!enabled()||!v?.snapshot.question)throw Error('automatic_wechat_question_unavailable');
   return options.generate(l,v.snapshot.question);
  },
  submit:async(l,d)=>{
   const saved=verified.get(l);if(!enabled()||!saved?.snapshot.fence)return {outcome:'rejected'};
   const request={lease:l,appId:saved.target.appId,openId:saved.target.openId,draftText:d.text,
    sourceOccurredAt:saved.target.sourceOccurredAt,...(saved.target.merchantName!==null?{merchantName:saved.target.merchantName}:{})};
   const content=automaticWeChatContent(request);
   try{
    const label=await readPublicAiLabel(db,l.tenantId);
    const transport=createAutomaticWeChatTransport({enabled,fetcher:options.fetcher,showAiLabel:label.effective,
     resolveAccessToken:(appId,_channel,_connection,signal)=>options.resolveAccessToken(l,appId,signal),
     claimAuthorizedAttempt:attempt=>claim(attempt,saved.target,saved.snapshot.fence!)});
    const result=await transport.send(request);
    // Persist the provider outcome before the generic executor's terminal state.
    // Lost DB acknowledgement never causes another provider request.
    await recordAutomaticWeChatOutcome(db,l,content??d.text,result);
    return result;
   }finally{verified.delete(l);}
  }
 });
}
