import type {PoolClient} from 'pg';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import {AUTOMATIC_SEND_CONSENT_VERSION} from './automatic-reply-policy.js';
import {automaticModeGuard} from './automatic-reception-mode.js';
import {loadAutomaticWeChatTarget} from './automatic-wechat-target.js';

/** Caller owns the bounded transaction. This is a lease/data permission check,
 * not permission to send: channel facts, pause and human reply fences are still
 * independently required at the final native submit barrier. */
export async function currentAutomaticGenerationLease(c:Pick<PoolClient,'query'>,l:AutomaticReceptionLease,question:string,
 phase:'generation'|'send'='generation'){
 // Only the final sender explicitly opts into submitting. Generation/retrieval
 // never reopen a submitting or terminal job for another billed model request.
 if(phase!=='generation'&&phase!=='send')return false;
 const r=await c.query(`SELECT 1 FROM automatic_reception_jobs j JOIN automatic_reception_grants g ON g.tenant_id=j.tenant_id JOIN tenants t ON t.tenant_id=j.tenant_id
  JOIN tenant_ai_settings s ON s.tenant_id=j.tenant_id
  WHERE j.tenant_id=$1 AND j.job_id=$2 AND j.worker_token=$3 AND j.state=$12 AND j.message_id=$4
   AND j.account_id=$5 AND j.conversation_id=$6 AND j.customer_id=$7 AND j.channel=$8 AND j.connection_id IS NOT DISTINCT FROM $9::uuid
   AND j.authorization_id=$10 AND j.consent_version=$11 AND g.authorization_id=j.authorization_id AND g.account_id=j.account_id
   AND g.enabled AND g.consent_version=$11 AND t.status IN('active','test') AND t.chatwoot_account_id::text=j.account_id
   AND ${automaticModeGuard} AND j.locked_at>NOW()-INTERVAL '2 minutes' FOR SHARE OF j,g,t,s`,
  [l.tenantId,l.jobId,l.workerToken,l.messageId,l.accountId,l.conversationId,l.customerId,l.channel,l.connectionId,l.authorizationId,AUTOMATIC_SEND_CONSENT_VERSION,
   phase==='send'?'submitting':'processing']);
 if(r.rowCount!==1)return false;
 if(l.channel==='web_chat')return true;
 const target=await loadAutomaticWeChatTarget(c,l,true);
 return !!target&&target.question===question&&target.sourceOccurredAt<=Date.now()&&Date.now()-target.sourceOccurredAt<=600000;
}
