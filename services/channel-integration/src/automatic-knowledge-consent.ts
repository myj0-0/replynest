import type {PoolClient} from 'pg';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import {AUTOMATIC_SEND_CONSENT_VERSION} from './automatic-reply-policy.js';

export const KNOWLEDGE_SEND_DISCLOSURE_VERSION='web-chat-knowledge-faq-v2';
export const KNOWLEDGE_WECHAT_DISCLOSURE_VERSION='wechat-knowledge-faq-v2';
// Current long-text disclosure. Existing FAQ consent is NOT
// interpreted as permission to send prose sections to an embedding/text model.
export const SEMANTIC_KNOWLEDGE_SEND_DISCLOSURE_VERSION='web-chat-knowledge-semantic-v3';
export const SEMANTIC_KNOWLEDGE_WECHAT_DISCLOSURE_VERSION='wechat-knowledge-semantic-v3';
/** A release switch is not tenant consent. Only the current, explicitly confirmed
 * administrator disclosure can extend an exact-answer grant to published FAQ.
 * Old audit rows remain immutable and never authorize a newly rotated grant.
 */
export async function automaticKnowledgeAuthorized(db:Pick<PoolClient,'query'>,l:AutomaticReceptionLease,lock=false):Promise<boolean>{
 return knowledgeAuthorized(db,l,lock,[KNOWLEDGE_SEND_DISCLOSURE_VERSION,SEMANTIC_KNOWLEDGE_SEND_DISCLOSURE_VERSION],
  [KNOWLEDGE_WECHAT_DISCLOSURE_VERSION,SEMANTIC_KNOWLEDGE_WECHAT_DISCLOSURE_VERSION]);
}
export async function automaticSemanticKnowledgeAuthorized(db:Pick<PoolClient,'query'>,l:AutomaticReceptionLease,lock=false):Promise<boolean>{
 return knowledgeAuthorized(db,l,lock,[SEMANTIC_KNOWLEDGE_SEND_DISCLOSURE_VERSION],[SEMANTIC_KNOWLEDGE_WECHAT_DISCLOSURE_VERSION]);
}
async function knowledgeAuthorized(db:Pick<PoolClient,'query'>,l:AutomaticReceptionLease,lock:boolean,primaryVersion:string[],wechatVersion:string[]):Promise<boolean>{
 const primary=await db.query(`SELECT g.authorization_id FROM automatic_reception_grants g
  WHERE g.tenant_id=$1 AND g.account_id=$2 AND g.authorization_id=$3 AND g.enabled AND g.consent_version=$4
   AND EXISTS(SELECT 1 FROM automatic_reception_management_audit a WHERE a.tenant_id=g.tenant_id
    AND a.resource_id=g.authorization_id AND a.action='grant.enabled'
    AND a.actor_id::text=g.actor_id AND a.metadata->>'disclosure_version'=ANY($5::text[])
    AND a.metadata->>'consent_version'=$4) ${lock?'FOR SHARE OF g':''}`,
  [l.tenantId,l.accountId,l.authorizationId,AUTOMATIC_SEND_CONSENT_VERSION,primaryVersion]);
 if(primary.rowCount!==1)return false;
 if(l.channel==='web_chat')return true;
 if(!['shared_wechat','wechat_official_account'].includes(l.channel))return false;
 const wechat=await db.query(`SELECT g.grant_id FROM automatic_reception_wechat_grants g
  WHERE g.tenant_id=$1 AND g.authorization_id=$2 AND g.enabled AND g.consent_version='wechat-automatic-send-v1'
   AND $3=ANY(g.channels) AND EXISTS(SELECT 1 FROM automatic_reception_wechat_audit a
    WHERE a.tenant_id=g.tenant_id AND a.authorization_id=g.authorization_id AND a.grant_id=g.grant_id
     AND a.actor_id::text=g.actor_id AND a.action='wechat.granted' AND $3=ANY(a.channels)
     AND a.disclosure_version=ANY($4::text[]) AND a.consent_version=g.consent_version) ${lock?'FOR SHARE OF g':''}`,
  [l.tenantId,l.authorizationId,l.channel,wechatVersion]);
 return wechat.rowCount===1;
}
