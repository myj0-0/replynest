import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {authenticateAutomaticAdministrator} from './automatic-reception-auth.js';
import {AUTOMATIC_SEND_CONSENT_VERSION} from './automatic-reply-policy.js';
import {AUTOMATIC_WECHAT_SEND_CONSENT_VERSION} from './automatic-wechat-target.js';
import {automaticModeGuard} from './automatic-reception-mode.js';
// Errors are shared with the existing management API, never raw SQL/provider errors.
import {AutomaticManagementError,automaticUuid} from './automatic-reception-management.js';
import {KNOWLEDGE_WECHAT_DISCLOSURE_VERSION,SEMANTIC_KNOWLEDGE_WECHAT_DISCLOSURE_VERSION} from './automatic-knowledge-consent.js';

export const AUTOMATIC_WECHAT_DISCLOSURE_VERSION=SEMANTIC_KNOWLEDGE_WECHAT_DISCLOSURE_VERSION;
export const AUTOMATIC_WECHAT_DISCLOSURE='仅授权勾选的公众号渠道：读取本企业的新客户问题及相关已发布知识。通过检索安全处理完成、当前有效的知识库问答和长文段落，组织答复并独立核验来源。检索可能调用嵌入模型，生成和核验分别调用文本模型并消耗 AI 点数；未找到来源、核验未通过或发送失败时，已发生的实际用量仍计费。不读取整库、客户档案或历史聊天；仅将当前问题与有界相关原文送给模型。只发送来源支持、条件完整、无冲突、达到接待阈值的低风险内容，不能保证任意长文都能自动回答。人工分配不停止 AI 接待，客服可对客户暂停 10 分钟或提前恢复；到期仅接待新问题，人工已回答的问题不重复回复。共享公众号仅回复当前明确咨询本商家的用户，不进行营销群发；回复会标明商家。微信回复窗口、权限和频率限制可能导致发送失败。结果不确定时不自动重发，可随时撤销；已提交的请求无法撤回。';
export const AUTOMATIC_WECHAT_CHANNELS=['wechat_official_account','shared_wechat'] as const;
export type AutomaticWeChatChannel=typeof AUTOMATIC_WECHAT_CHANNELS[number];
export type AutomaticWeChatGrantAction={enabled:boolean;expectedAuthorization:string;expectedGrant:string|null;channels:AutomaticWeChatChannel[]};
const fail=(code:string,status=400):never=>{throw new AutomaticManagementError(code,status);};
export function validateAutomaticWeChatGrant(value:unknown):AutomaticWeChatGrantAction{
 if(!value||typeof value!=='object'||Array.isArray(value))fail('invalid_payload');
 const v=value as Record<string,unknown>;
 if(typeof v.enabled!=='boolean'||!automaticUuid(v.expected_authorization_id)||!(v.expected_grant_id===null||automaticUuid(v.expected_grant_id)))fail('invalid_payload');
 const keys=v.enabled?['enabled','expected_authorization_id','expected_grant_id','channels','confirmed','consent_version','disclosure_version']:['enabled','expected_authorization_id','expected_grant_id'];
 if(Object.keys(v).sort().join(',')!==keys.sort().join(','))fail('invalid_payload');
 if(v.enabled&&(v.confirmed!==true||v.consent_version!==AUTOMATIC_WECHAT_SEND_CONSENT_VERSION||v.disclosure_version!==AUTOMATIC_WECHAT_DISCLOSURE_VERSION))fail('wechat_confirmation_required');
 let channels:AutomaticWeChatChannel[]=[];
 if(v.enabled){
  if(!Array.isArray(v.channels)||v.channels.length<1||v.channels.length>2||new Set(v.channels).size!==v.channels.length||v.channels.some(c=>!AUTOMATIC_WECHAT_CHANNELS.includes(c)))fail('invalid_payload');
  channels=[...(v.channels as AutomaticWeChatChannel[])].sort();
 }
 return {enabled:v.enabled as boolean,expectedAuthorization:String(v.expected_authorization_id),expectedGrant:v.expected_grant_id as string|null,channels};
}
// Explicit migration only. Never run from an HTTP handler or module import.
export const automaticWechatManagementSchema=`
 CREATE TABLE IF NOT EXISTS automatic_reception_wechat_audit(
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  actor_id UUID NOT NULL REFERENCES platform_users(platform_user_id),session_id UUID NOT NULL REFERENCES console_sessions(session_id),
  action TEXT NOT NULL CHECK(action IN('wechat.granted','wechat.revoked')),
  authorization_id UUID NOT NULL,grant_id UUID NOT NULL,
  consent_version TEXT NOT NULL CHECK(consent_version='${AUTOMATIC_WECHAT_SEND_CONSENT_VERSION}'),
  disclosure_version TEXT NOT NULL CHECK(disclosure_version IN('wechat-exact-answers-v1','${KNOWLEDGE_WECHAT_DISCLOSURE_VERSION}','${AUTOMATIC_WECHAT_DISCLOSURE_VERSION}')),
  channels TEXT[] NOT NULL CHECK(cardinality(channels) BETWEEN 1 AND 2 AND channels <@ ARRAY['wechat_official_account','shared_wechat']::text[]),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
 );
 -- Retain historical v1/v2 disclosures; migrate the constraint, never rewrite audit rows.
 ALTER TABLE automatic_reception_wechat_audit DROP CONSTRAINT IF EXISTS automatic_reception_wechat_audit_disclosure_version_check;
 ALTER TABLE automatic_reception_wechat_audit ADD CONSTRAINT automatic_reception_wechat_audit_disclosure_version_check
  CHECK(disclosure_version IN('wechat-exact-answers-v1','${KNOWLEDGE_WECHAT_DISCLOSURE_VERSION}','${AUTOMATIC_WECHAT_DISCLOSURE_VERSION}'));
 CREATE INDEX IF NOT EXISTS automatic_wechat_audit_page ON automatic_reception_wechat_audit(tenant_id,created_at DESC,audit_id DESC);
 CREATE INDEX IF NOT EXISTS automatic_wechat_disclosure_lookup ON automatic_reception_wechat_audit(tenant_id,authorization_id,grant_id)
  WHERE action='wechat.granted';
 DROP TRIGGER IF EXISTS automatic_wechat_audit_guard ON automatic_reception_wechat_audit;
 CREATE TRIGGER automatic_wechat_audit_guard BEFORE UPDATE OR DELETE ON automatic_reception_wechat_audit
  FOR EACH ROW EXECUTE FUNCTION protect_automatic_management_audit();
 DROP TRIGGER IF EXISTS automatic_wechat_audit_truncate_guard ON automatic_reception_wechat_audit;
 CREATE TRIGGER automatic_wechat_audit_truncate_guard BEFORE TRUNCATE ON automatic_reception_wechat_audit
  FOR EACH STATEMENT EXECUTE FUNCTION protect_automatic_management_audit();
`;
export async function readAutomaticWeChatGrant(c:Pick<PoolClient,'query'>,tenant:string){
 const grant=(await c.query(`SELECT wg.grant_id,wg.authorization_id,wg.channels,wg.created_at,
  (wg.enabled AND EXISTS(SELECT 1 FROM automatic_reception_wechat_audit a WHERE a.tenant_id=wg.tenant_id
   AND a.authorization_id=wg.authorization_id AND a.grant_id=wg.grant_id AND a.action='wechat.granted'
   AND a.actor_id::text=wg.actor_id AND a.disclosure_version=$3 AND a.channels @> wg.channels)) knowledge_confirmed,
  (wg.enabled AND g.enabled AND g.authorization_id=wg.authorization_id AND g.consent_version=$2 AND ${automaticModeGuard}) enabled
  FROM automatic_reception_wechat_grants wg JOIN automatic_reception_grants g ON g.tenant_id=wg.tenant_id
  JOIN tenant_ai_settings s ON s.tenant_id=g.tenant_id JOIN tenants t ON t.tenant_id=g.tenant_id AND t.chatwoot_account_id::text=g.account_id
  WHERE wg.tenant_id=$1`,[tenant,AUTOMATIC_SEND_CONSENT_VERSION,AUTOMATIC_WECHAT_DISCLOSURE_VERSION])).rows[0]??null;
 return {grant,channels:[...AUTOMATIC_WECHAT_CHANNELS],consent_version:AUTOMATIC_WECHAT_SEND_CONSENT_VERSION,
  disclosure_version:AUTOMATIC_WECHAT_DISCLOSURE_VERSION,disclosure:AUTOMATIC_WECHAT_DISCLOSURE};
}
/** Same session, membership and management advisory lock as website authorization.
 * The primary authorization is a prerequisite, not inherited WeChat consent.
 * Tombstones retain a fresh grant ID: revoke/re-enable cannot revive a stale view.
 */
export async function manageAutomaticWeChatGrant(db:Pick<Pool,'connect'>,token:string,input:unknown,expectedTenant?:string){
 const action=validateAutomaticWeChatGrant(input);
 if(!/^[a-f0-9]{64}$/.test(token))fail('unauthorized',401);
 const c=await db.connect();
 try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms'");
  const auth=await authenticateAutomaticAdministrator(c,token);if(!auth)fail('administrator_session_required',403);
  if(expectedTenant!==undefined&&auth.tenant_id!==expectedTenant)fail('workspace_changed',409);
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`automatic-management:${auth.tenant_id}`]);
  const primary=(await c.query(`SELECT g.authorization_id,g.enabled,g.account_id,g.consent_version,${automaticModeGuard} mode_ready
   FROM automatic_reception_grants g JOIN tenant_ai_settings s ON s.tenant_id=g.tenant_id WHERE g.tenant_id=$1 FOR UPDATE OF g`,[auth.tenant_id])).rows[0];
  if(!primary||primary.authorization_id!==action.expectedAuthorization||primary.account_id!==auth.account_id)fail('authorization_conflict',409);
  if(action.enabled&&(!primary.enabled||primary.consent_version!==AUTOMATIC_SEND_CONSENT_VERSION||!primary.mode_ready))fail('primary_authorization_required',409);
  const current=(await c.query('SELECT grant_id,channels FROM automatic_reception_wechat_grants WHERE tenant_id=$1 FOR UPDATE',[auth.tenant_id])).rows[0];
  if((current?.grant_id??null)!==action.expectedGrant)fail('wechat_authorization_conflict',409);
  if(!action.enabled&&!current)fail('wechat_authorization_conflict',409);
  const id=randomUUID(),channels=action.enabled?action.channels:current.channels;
  await c.query(`INSERT INTO automatic_reception_wechat_grants(tenant_id,authorization_id,consent_version,channels,actor_id,created_at,grant_id,enabled)
   VALUES($1,$2,$3,$4,$5,clock_timestamp(),$6,$7) ON CONFLICT(tenant_id) DO UPDATE SET
    authorization_id=EXCLUDED.authorization_id,consent_version=EXCLUDED.consent_version,channels=EXCLUDED.channels,
    actor_id=EXCLUDED.actor_id,created_at=EXCLUDED.created_at,grant_id=EXCLUDED.grant_id,enabled=EXCLUDED.enabled`,
   [auth.tenant_id,primary.authorization_id,AUTOMATIC_WECHAT_SEND_CONSENT_VERSION,channels,auth.platform_user_id,id,action.enabled]);
  await c.query(`INSERT INTO automatic_reception_wechat_audit(tenant_id,actor_id,session_id,action,authorization_id,grant_id,consent_version,disclosure_version,channels)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[auth.tenant_id,auth.platform_user_id,auth.session_id,action.enabled?'wechat.granted':'wechat.revoked',
   primary.authorization_id,id,AUTOMATIC_WECHAT_SEND_CONSENT_VERSION,AUTOMATIC_WECHAT_DISCLOSURE_VERSION,channels]);
  const result=await readAutomaticWeChatGrant(c,auth.tenant_id);await c.query('COMMIT');return {wechat:result};
 }catch(error){await c.query('ROLLBACK').catch(()=>{});if(error instanceof AutomaticManagementError)throw error;throw new AutomaticManagementError('management_result_uncertain',503);}
 finally{c.release();}
}
