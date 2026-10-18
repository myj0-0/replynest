import {createCipheriv,createDecipheriv,createHmac,randomBytes} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import type {AutomaticWeChatNativeTarget} from './automatic-wechat-native-client.js';
import {automaticWeChatHistoryTargetPayload,type AutomaticWeChatHistoryTarget} from './automatic-wechat-history-native-client.js';

export const automaticWechatHistoryEnvelopeSchema=`
 CREATE TABLE IF NOT EXISTS automatic_reception_wechat_envelopes(
  job_id UUID PRIMARY KEY REFERENCES automatic_reception_jobs(job_id),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  worker_token UUID NOT NULL,envelope_version INTEGER NOT NULL DEFAULT 1 CHECK(envelope_version=1),
  nonce BYTEA NOT NULL CHECK(octet_length(nonce)=12),auth_tag BYTEA NOT NULL CHECK(octet_length(auth_tag)=16),
  ciphertext BYTEA NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 16384),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
 );
 DROP TRIGGER IF EXISTS automatic_wechat_envelope_immutable ON automatic_reception_wechat_envelopes;
 CREATE TRIGGER automatic_wechat_envelope_immutable BEFORE UPDATE ON automatic_reception_wechat_envelopes
  FOR EACH ROW EXECUTE FUNCTION protect_automatic_management_audit();
 DROP TRIGGER IF EXISTS automatic_wechat_envelope_no_truncate ON automatic_reception_wechat_envelopes;
 CREATE TRIGGER automatic_wechat_envelope_no_truncate BEFORE TRUNCATE ON automatic_reception_wechat_envelopes
  FOR EACH STATEMENT EXECUTE FUNCTION protect_automatic_management_audit();
`;
export type AutomaticWeChatEnvelope={nonce:Buffer;auth_tag:Buffer;ciphertext:Buffer;envelope_version:number};
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
function aad(l:AutomaticReceptionLease){
 if(![l.jobId,l.workerToken,l.customerId,l.authorizationId].every(uuid)||typeof l.tenantId!=='string'||!l.tenantId.trim()||l.tenantId.length>200||
  l.tenantId.includes('\0')||!['shared_wechat','wechat_official_account'].includes(l.channel)||l.consentVersion!=='automatic-send-v1'||
  (l.channel==='shared_wechat'?l.connectionId!==null:!uuid(l.connectionId)))throw Error();
 return Buffer.from(JSON.stringify(['replynest-wechat-history-envelope-v1',l.jobId,l.tenantId,l.workerToken,l.channel,l.accountId,
  l.conversationId,l.customerId,l.messageId,l.connectionId,l.authorizationId,l.consentVersion]));
}
function key(secret:string){
 if(typeof secret!=='string'||Buffer.byteLength(secret)<32||Buffer.byteLength(secret)>65536||/[\0\r\n]/.test(secret))throw Error();
 // Domain-separated derivation: never use the HMAC signing key directly as AES.
 return createHmac('sha256',secret).update('replynest:wechat-history-envelope:aes-256-gcm:v1').digest();
}
function plain(l:AutomaticReceptionLease,target:AutomaticWeChatHistoryTarget,content:string){
 const p=automaticWeChatHistoryTargetPayload(target,l.messageId);
 if(p.provider!==l.channel||p.account_id!==l.accountId||p.conversation_id!==l.conversationId||(target.customerId!==undefined&&target.customerId!==l.customerId)||
  typeof content!=='string'||!content.trim()||Buffer.byteLength(content)>1800||content.includes('\0')||
  Buffer.from(content).toString('utf8')!==content)throw Error();
 // Serialize ONLY known native fields, not an extensible caller-owned object.
 return {target:{accountId:p.account_id,conversationId:p.conversation_id,inboxId:p.inbox_id,contactId:p.contact_id,
  authorizationAt:p.authorization_at,provider:p.provider,contactIdentifier:p.contact_identifier,
  sourceEventId:p.source_event_id,sourceOccurredAt:p.source_occurred_at,...(target.customerId===undefined?{}:{customerId:target.customerId})},content};
}
export function sealAutomaticWeChatEnvelope(l:AutomaticReceptionLease,target:AutomaticWeChatNativeTarget,content:string,secret:string):AutomaticWeChatEnvelope{
 try{
  const value=Buffer.from(JSON.stringify(plain(l,target,content))),nonce=randomBytes(12);
  if(value.length>16384)throw Error();const cipher=createCipheriv('aes-256-gcm',key(secret),nonce);cipher.setAAD(aad(l));
  const ciphertext=Buffer.concat([cipher.update(value),cipher.final()]);
  return {nonce,ciphertext,auth_tag:cipher.getAuthTag(),envelope_version:1};
 }catch{throw Error('automatic_wechat_envelope_invalid');}
}
export function openAutomaticWeChatEnvelope(l:AutomaticReceptionLease,row:AutomaticWeChatEnvelope,secret:string):{target:AutomaticWeChatHistoryTarget;content:string}{
 try{
  if(row.envelope_version!==1||!Buffer.isBuffer(row.nonce)||row.nonce.length!==12||!Buffer.isBuffer(row.auth_tag)||row.auth_tag.length!==16||
   !Buffer.isBuffer(row.ciphertext)||!row.ciphertext.length||row.ciphertext.length>16384)throw Error();
  const decipher=createDecipheriv('aes-256-gcm',key(secret),row.nonce);decipher.setAAD(aad(l));decipher.setAuthTag(row.auth_tag);
  const text=Buffer.concat([decipher.update(row.ciphertext),decipher.final()]).toString('utf8'),v=JSON.parse(text);
  const result=plain(l,v.target,v.content);
  if(JSON.stringify(result)!==text)throw Error();return result;
 }catch{throw Error('automatic_wechat_envelope_unavailable');}
}
/** Caller owns the SAME short transaction as the durable attempt marker. No
 * HTTP, file read or provider call. A changed route/name cannot replace this
 * envelope. Failed persistence prevents a send permit from being requested.
 * DELETE is reserved for later retention/privacy cleanup, never re-sending.
 */
export async function persistAutomaticWeChatEnvelope(c:Pick<PoolClient,'query'>,l:AutomaticReceptionLease,target:AutomaticWeChatNativeTarget,content:string,secret:string){
 const row=sealAutomaticWeChatEnvelope(l,target,content,secret);
 const inserted=await c.query(`INSERT INTO automatic_reception_wechat_envelopes(job_id,tenant_id,worker_token,nonce,auth_tag,ciphertext)
  SELECT job_id,tenant_id,worker_token,$4,$5,$6 FROM automatic_reception_jobs WHERE job_id=$1 AND tenant_id=$2 AND worker_token=$3
   AND state='submitting' AND transport_attempted_at IS NULL AND channel=$7 AND account_id=$8 AND conversation_id=$9
   AND message_id=$10 AND customer_id=$11 AND connection_id IS NOT DISTINCT FROM $12::uuid AND authorization_id=$13 AND consent_version=$14
  ON CONFLICT(job_id) DO NOTHING RETURNING job_id`,[l.jobId,l.tenantId,l.workerToken,row.nonce,row.auth_tag,row.ciphertext,
   l.channel,l.accountId,l.conversationId,l.messageId,l.customerId,l.connectionId,l.authorizationId,l.consentVersion]);
 if(inserted.rowCount===1)return;
 const existing=await c.query(`SELECT e.* FROM automatic_reception_wechat_envelopes e JOIN automatic_reception_jobs j
  ON j.job_id=e.job_id AND j.tenant_id=e.tenant_id AND j.worker_token=e.worker_token
  WHERE e.job_id=$1 AND e.tenant_id=$2 AND e.worker_token=$3 AND j.state='submitting' AND j.transport_attempted_at IS NULL
   AND j.channel=$4 AND j.account_id=$5 AND j.conversation_id=$6 AND j.message_id=$7 AND j.customer_id=$8
   AND j.connection_id IS NOT DISTINCT FROM $9::uuid AND j.authorization_id=$10 AND j.consent_version=$11`,
  [l.jobId,l.tenantId,l.workerToken,l.channel,l.accountId,l.conversationId,l.messageId,l.customerId,l.connectionId,l.authorizationId,l.consentVersion]);
 try{
  if(existing.rows.length!==1||JSON.stringify(openAutomaticWeChatEnvelope(l,existing.rows[0],secret))!==JSON.stringify(plain(l,target,content)))throw Error();
 }catch{throw Error('automatic_wechat_envelope_binding_conflict');}
}
