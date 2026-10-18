import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import type {AutomaticWeChatResult} from './automatic-wechat-transport.js';
export const automaticWeChatReasons=['execution_disabled','invalid_target','invalid_content','source_message_stale','reply_window_expired',
 'credentials_unavailable','authorization_changed','attempt_already_claimed','attempt_unconfirmed','provider_rate_limited',
 'provider_permission_denied','provider_rejected','provider_result_uncertain'] as const;
/** Explicit migration only. No plaintext, credential, OpenID or raw provider error. */
export const automaticWechatOutcomeSchema=`
 CREATE TABLE IF NOT EXISTS automatic_reception_wechat_outcomes(
  job_id UUID PRIMARY KEY REFERENCES automatic_reception_jobs(job_id),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  worker_token UUID NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN('accepted','rejected','uncertain')),
  reason TEXT NOT NULL CHECK(reason IN('provider_accepted',${automaticWeChatReasons.map(r=>`'${r}'`).join(',')})),
  provider_code INTEGER CHECK(provider_code>0),content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK(outcome<>'accepted' OR (reason='provider_accepted' AND provider_code IS NULL))
 );
 CREATE INDEX IF NOT EXISTS automatic_wechat_outcome_page ON automatic_reception_wechat_outcomes(tenant_id,created_at DESC,job_id);
 DROP TRIGGER IF EXISTS automatic_wechat_outcome_guard ON automatic_reception_wechat_outcomes;
 CREATE TRIGGER automatic_wechat_outcome_guard BEFORE UPDATE OR DELETE ON automatic_reception_wechat_outcomes
  FOR EACH ROW EXECUTE FUNCTION protect_automatic_management_audit();
 DROP TRIGGER IF EXISTS automatic_wechat_outcome_truncate_guard ON automatic_reception_wechat_outcomes;
 CREATE TRIGGER automatic_wechat_outcome_truncate_guard BEFORE TRUNCATE ON automatic_reception_wechat_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION protect_automatic_management_audit();
`;
export async function recordAutomaticWeChatOutcome(db:Pick<PoolClient,'query'>,l:AutomaticReceptionLease,content:string,r:AutomaticWeChatResult){
 if(!['wechat_official_account','shared_wechat'].includes(l.channel)||typeof content!=='string'||!content.trim()||Buffer.byteLength(content)>16000||
  (r.outcome==='accepted'&&Buffer.byteLength(content)>1800))throw Error('invalid_wechat_outcome');
 const accepted=r.outcome==='accepted';
 const reason=accepted?'provider_accepted':r.reason;
 const code=accepted?null:r.providerCode??null;
 if(!['accepted','rejected','uncertain'].includes(r.outcome)||
  (accepted?(r.receipt.provider!==l.channel||r.receipt.acknowledged!==true||Object.keys(r.receipt).sort().join(',')!=='acknowledged,provider'):
    !automaticWeChatReasons.includes(reason as typeof automaticWeChatReasons[number]))||
  (code!==null&&(!Number.isInteger(code)||code<=0||code>2147483647)))throw Error('invalid_wechat_outcome');
 const digest=createHash('sha256').update(content).digest('hex');
 const inserted=await db.query(`INSERT INTO automatic_reception_wechat_outcomes(job_id,tenant_id,worker_token,outcome,reason,provider_code,content_sha256)
  SELECT j.job_id,j.tenant_id,j.worker_token,$4,$5,$6,$7 FROM automatic_reception_jobs j
  WHERE j.tenant_id=$1 AND j.job_id=$2 AND j.worker_token=$3 AND j.state='submitting' AND j.channel=$8
   AND j.account_id=$9 AND j.conversation_id=$10 AND j.customer_id=$11 AND j.message_id=$12
   AND j.connection_id IS NOT DISTINCT FROM $13::uuid AND j.authorization_id=$14 AND j.consent_version=$15
   AND ($4<>'accepted' OR j.transport_attempted_at IS NOT NULL)
  ON CONFLICT(job_id) DO NOTHING RETURNING job_id`,[l.tenantId,l.jobId,l.workerToken,r.outcome,reason,code,digest,l.channel,
   l.accountId,l.conversationId,l.customerId,l.messageId,l.connectionId,l.authorizationId,l.consentVersion]);
 if(inserted.rowCount===1)return;
 const prior=await db.query(`SELECT 1 FROM automatic_reception_wechat_outcomes o JOIN automatic_reception_jobs j
  ON j.job_id=o.job_id AND j.tenant_id=o.tenant_id AND j.worker_token=o.worker_token
  WHERE o.tenant_id=$1 AND o.job_id=$2 AND o.worker_token=$3
  AND o.outcome=$4 AND o.reason=$5 AND o.provider_code IS NOT DISTINCT FROM $6::integer AND o.content_sha256=$7
  AND j.channel=$8 AND j.account_id=$9 AND j.conversation_id=$10 AND j.customer_id=$11 AND j.message_id=$12
  AND j.connection_id IS NOT DISTINCT FROM $13::uuid AND j.authorization_id=$14 AND j.consent_version=$15`,
  [l.tenantId,l.jobId,l.workerToken,r.outcome,reason,code,digest,l.channel,l.accountId,l.conversationId,
   l.customerId,l.messageId,l.connectionId,l.authorizationId,l.consentVersion]);
 if(prior.rowCount!==1)throw Error('wechat_outcome_binding_conflict');
}
