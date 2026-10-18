import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {AutomaticReceptionLease} from './automatic-reception-store.js';
import type {AutomaticWeChatNativeTarget} from './automatic-wechat-native-client.js';
import {AUTOMATIC_SEND_CONSENT_VERSION} from './automatic-reply-policy.js';
import {automaticModeGuard} from './automatic-reception-mode.js';
import {automaticSharedRouteDecision} from './automatic-shared-wechat-policy.js';
import type {RoutingState} from './shared-wechat-routing.js';

type Db=Pick<PoolClient,'query'>;
export const AUTOMATIC_WECHAT_SEND_CONSENT_VERSION='wechat-automatic-send-v1';
export type AutomaticWeChatTarget=Readonly<{
 native:AutomaticWeChatNativeTarget;appId:string;openId:string;question:string;sourceOccurredAt:number;
 routeVersion:number|null;merchantName:string|null;wechatGrantId:string;
}>;
const id=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v);
const date=(v:unknown):number=>v instanceof Date?v.getTime():typeof v==='string'?Date.parse(v):NaN;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Indexed native-message lookups only. lock=true requires a caller-owned READ COMMITTED
 * transaction. Shared state uses the same contact advisory lock as merchant switching.
 * Old receipts without VERIFIED event time/contact ID fail closed; never backfill from NOW.
 */
export async function loadAutomaticWeChatTarget(db:Db,l:AutomaticReceptionLease,lock=false):Promise<AutomaticWeChatTarget|null>{
 if(!['wechat_official_account','shared_wechat'].includes(l.channel)||!uuid(l.jobId)||!uuid(l.customerId)||!uuid(l.authorizationId)||
  !uuid(l.workerToken)||![l.accountId,l.conversationId,l.messageId].every(id)||l.consentVersion!==AUTOMATIC_SEND_CONSENT_VERSION||
  (l.channel==='shared_wechat'?l.connectionId!==null:!uuid(l.connectionId)))return null;
 let result;
 const values=[l.tenantId,l.customerId,l.conversationId,l.accountId,l.authorizationId,AUTOMATIC_SEND_CONSENT_VERSION,l.messageId];
 const common=`JOIN tenants t ON t.tenant_id=i.tenant_id JOIN automatic_reception_grants g ON g.tenant_id=t.tenant_id
  JOIN tenant_ai_settings s ON s.tenant_id=t.tenant_id
  JOIN automatic_reception_wechat_grants wg ON wg.tenant_id=g.tenant_id AND wg.authorization_id=g.authorization_id
   AND wg.enabled AND wg.consent_version='${AUTOMATIC_WECHAT_SEND_CONSENT_VERSION}' AND i.channel=ANY(wg.channels)`;
 const gate=`i.tenant_id=$1 AND i.customer_id=$2 AND i.chatwoot_conversation_id::text=$3
  AND t.chatwoot_account_id::text=$4 AND t.status IN('active','test') AND g.account_id=$4
  AND g.authorization_id=$5 AND g.consent_version=$6 AND g.enabled AND ${automaticModeGuard}`;
 if(l.channel==='wechat_official_account'){
  result=await db.query(`SELECT c.external_account_id app_id,i.external_user_id open_id,i.chatwoot_contact_id::text contact_id,
   c.configuration->>'chatwoot_inbox_id' inbox_id,wg.grant_id,
   CEIL(EXTRACT(EPOCH FROM GREATEST(g.updated_at,wg.created_at))*1000)::text authorization_ms,
   e.external_event_id event_id,e.payload->'normalized'->>'occurred_at' source_occurred_at,
   e.payload->'normalized'->>'text' question
   FROM channel_identities i ${common}
   JOIN channel_connections c ON c.tenant_id=i.tenant_id AND c.connection_id=i.channel_connection_id
   JOIN gateway_events e ON e.tenant_id=i.tenant_id AND e.channel=i.channel AND e.channel_connection_id=i.channel_connection_id
    AND e.chatwoot_message_id=$7::bigint AND e.status='processed'
    AND e.payload->'normalized'->>'user_id'=i.external_user_id
    AND e.payload->'normalized'->>'event_id'=e.external_event_id
    AND e.payload->'normalized'->>'message_id'=e.external_message_id
   WHERE ${gate} AND i.channel='wechat_official_account' AND i.channel_connection_id=$8::uuid
    AND c.channel_type=i.channel AND c.status='ready' AND c.configuration->>'chatwoot_account_id'=$4
    AND NOT EXISTS(SELECT 1 FROM shared_wechat_accounts a WHERE a.app_id=c.external_account_id AND a.enabled)
   ORDER BY i.identity_id,e.id LIMIT 2 ${lock?'FOR SHARE OF i,t,g,s,wg,c,e':''}`,[...values,l.connectionId]);
 }else{
  const hint=await db.query(`SELECT r.app_id,r.open_id FROM shared_wechat_deliveries d
   JOIN shared_wechat_receipts r ON r.app_id=d.app_id AND r.event_id=d.command_id AND r.destination_tenant_id=d.tenant_id AND r.open_id=d.open_id
   WHERE d.tenant_id=$1 AND d.direction='in' AND d.status='delivered' AND d.upstream_message_id=$2 LIMIT 2`,[l.tenantId,l.messageId]);
  if(hint.rows.length!==1)return null;
  const h=hint.rows[0];
  if(lock)await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`shared-wechat:${h.app_id}:${h.open_id}`]);
  result=await db.query(`SELECT r.app_id,r.open_id,i.chatwoot_contact_id::text contact_id,b.inbox_id::text inbox_id,
   wg.grant_id,CEIL(EXTRACT(EPOCH FROM GREATEST(g.updated_at,wg.created_at))*1000)::text authorization_ms,
   r.event_id,r.source_occurred_at,r.text_content question,r.route_version,
   t.name merchant_name,i.external_user_id,rs.state routing_state,
   EXTRACT(EPOCH FROM clock_timestamp())*1000 database_now
   FROM channel_identities i ${common}
   JOIN shared_wechat_threads b ON b.tenant_id=i.tenant_id AND b.conversation_id=i.chatwoot_conversation_id
    AND b.account_id=t.chatwoot_account_id AND b.contact_id=i.chatwoot_contact_id
   JOIN shared_wechat_accounts a ON a.app_id=b.app_id AND a.enabled
   JOIN shared_wechat_enrollments en ON en.app_id=b.app_id AND en.tenant_id=b.tenant_id AND en.enabled
   JOIN shared_wechat_inboxes ib ON ib.app_id=b.app_id AND ib.tenant_id=b.tenant_id AND ib.account_id=b.account_id AND ib.inbox_id=b.inbox_id AND ib.enabled
   JOIN shared_wechat_deliveries d ON d.app_id=b.app_id AND d.tenant_id=b.tenant_id AND d.open_id=b.open_id
    AND d.direction='in' AND d.status='delivered' AND d.upstream_message_id=$7
   JOIN shared_wechat_receipts r ON r.app_id=d.app_id AND r.event_id=d.command_id AND r.open_id=b.open_id
    AND r.destination_tenant_id=b.tenant_id AND r.decision->>'action'='route' AND r.delivery_state='held'
   JOIN shared_wechat_routing_states rs ON rs.app_id=b.app_id AND rs.open_id=b.open_id
   WHERE ${gate} AND i.channel='shared_wechat' AND i.channel_connection_id IS NULL AND r.app_id=$8 AND r.open_id=$9
   ORDER BY i.identity_id,r.event_id LIMIT 2 ${lock?'FOR SHARE OF i,t,g,s,wg,b,a,en,ib,d,r,rs':''}`,[...values,h.app_id,h.open_id]);
 }
 if(result.rows.length!==1)return null;
 const r=result.rows[0],sourceOccurredAt=date(r.source_occurred_at),authorized=Number(r.authorization_ms);
 // Ceil database microseconds, never round down and admit a pre-confirmation event.
 // The independent channel stores canonical ISO text; shared stores a timestamptz.
 if(typeof r.source_occurred_at==='string'&&!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.source_occurred_at))return null;
 if(!uuid(r.grant_id)||!id(r.contact_id)||!id(r.inbox_id)||typeof r.app_id!=='string'||!/^wx[a-f0-9]{16}$/.test(r.app_id)||
  typeof r.open_id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(r.open_id)||!Number.isSafeInteger(sourceOccurredAt)||
  !Number.isSafeInteger(authorized)||sourceOccurredAt<authorized||typeof r.event_id!=='string'||!r.event_id.trim()||
  Buffer.byteLength(r.event_id)>200||r.event_id.includes('\0')||typeof r.question!=='string'||!r.question.trim()||r.question.length>4000)return null;
 let contactIdentifier=`${l.connectionId}:${r.open_id}`,routeVersion:null|number=null,merchantName:null|string=null;
 if(l.channel==='shared_wechat'){
  const digest=hash([r.app_id,l.tenantId,r.open_id]);
  if(r.external_user_id!==digest||!Number.isSafeInteger(r.route_version)||
   !automaticSharedRouteDecision({appId:r.app_id,openId:r.open_id,tenantId:l.tenantId,routeVersion:r.route_version},r.routing_state as RoutingState,Math.floor(Number(r.database_now))).allowed)return null;
  contactIdentifier=`rn_shared_${digest}`;routeVersion=r.route_version;merchantName=r.merchant_name;
  if(typeof merchantName!=='string'||!merchantName.trim())return null;
 }
 return Object.freeze({appId:r.app_id,openId:r.open_id,question:r.question.trim(),sourceOccurredAt,routeVersion,merchantName,wechatGrantId:r.grant_id,
  native:Object.freeze({accountId:l.accountId,customerId:l.customerId,conversationId:l.conversationId,inboxId:r.inbox_id,contactId:r.contact_id,
   authorizationAt:new Date(authorized).toISOString(),provider:l.channel as AutomaticWeChatNativeTarget['provider'],
   contactIdentifier,sourceEventId:r.event_id,sourceOccurredAt:new Date(sourceOccurredAt).toISOString()})});
}

/** Explicit migration prerequisite, not automatically called at import/startup. */
export const automaticWechatLookupSchema=`
 -- Existing website consent NEVER enables WeChat. An explicit new channel disclosure is required.
 CREATE TABLE IF NOT EXISTS automatic_reception_wechat_grants(
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id),authorization_id UUID NOT NULL UNIQUE,
  consent_version TEXT NOT NULL CHECK(consent_version='${AUTOMATIC_WECHAT_SEND_CONSENT_VERSION}'),
  channels TEXT[] NOT NULL CHECK(cardinality(channels) BETWEEN 1 AND 2 AND channels <@ ARRAY['wechat_official_account','shared_wechat']::text[]),
  actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 200),created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
 );
 ALTER TABLE automatic_reception_wechat_grants ADD COLUMN IF NOT EXISTS grant_id UUID NOT NULL DEFAULT gen_random_uuid();
 ALTER TABLE automatic_reception_wechat_grants ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
 CREATE INDEX IF NOT EXISTS gateway_wechat_native_message_lookup ON gateway_events(tenant_id,channel_connection_id,chatwoot_message_id)
  WHERE channel='wechat_official_account' AND status='processed';
 CREATE INDEX IF NOT EXISTS shared_wechat_native_message_lookup ON shared_wechat_deliveries(tenant_id,upstream_message_id)
  WHERE direction='in' AND status='delivered';
`;
