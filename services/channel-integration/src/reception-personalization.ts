import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {authenticateAutomaticAdministrator} from './automatic-reception-auth.js';
import {parseReceptionTiming,parseReceptionTone,defaultReceptionTiming,type ReceptionTiming,type ReceptionTone} from './reception-presentation.js';
import {RECEPTION_HISTORY_DISCLOSURES,type ReceptionHistoryPurpose} from './reception-history-learning.js';
import {readPublicAiLabel} from './ai-public-label.js';

export const receptionHistoryDisclosures:Readonly<Record<ReceptionHistoryPurpose,string>>=Object.freeze({
 context:'允许读取本企业当前客户近30天的公开聊天，按有限条数和字符数选取相关上下文，经隐私处理后提供给回复模型。历史内容不能替代已发布知识，不能作为法规、费用或承诺的已核实依据；不读取私人便笺、已删除记录、其他企业或其他客户的聊天。模型实际用量会消耗AI点数。不授权发送；自动回复仍须另外保存渠道发送授权，可随时撤销。',
 style:'允许定期读取本企业近30天有界的公开人工回复，统计常见称呼、句长和表情等语气特征；不学习客户发言、私人便笺、已删除记录、AI或系统回复。不将历史原文或客户/坐席标识作为语气提示发送给模型，不从历史语气形成业务事实。不授权知识发布或发送，可随时撤销。',
 knowledgeDraft:'允许读取本企业近30天有界的公开客户问题和对应人工答案，经隐私处理后调用模型生成带来源的知识库草稿并消耗AI点数。历史可能包含过期、冲突或错误信息，草稿必须经管理员核对、编辑、确认和显式发布，再经正常安全处理与索引才可供接待使用。不自动发布、不授权发送、不读取私人便笺、已删除记录、其他企业或AI/系统回复，可随时撤销。'
});
export class ReceptionPersonalizationError extends Error {constructor(readonly code:string,readonly status=400){super(code);}}
function fail(code:string,status=400):never {throw new ReceptionPersonalizationError(code,status);}
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:fail('invalid_payload');
const exact=(value:Record<string,unknown>,names:string[])=>{if(Object.keys(value).sort().join(',')!==[...names].sort().join(','))fail('invalid_payload');};
const revision=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9]\d{0,18})$/.test(value)&&BigInt(value)<9223372036854775807n;
const purpose=(value:unknown):value is ReceptionHistoryPurpose=>typeof value==='string'&&Object.hasOwn(RECEPTION_HISTORY_DISCLOSURES,value);
export type ReceptionPersonalizationSettings=Readonly<{revision:string;draftTone:ReceptionTone;automaticTone:ReceptionTone;learnFromHuman:boolean;timing:ReceptionTiming}>;
export type ReceptionPersonalizationAction={kind:'settings';expectedRevision:string;settings:Omit<ReceptionPersonalizationSettings,'revision'>}|
 {kind:'history-grant';purpose:ReceptionHistoryPurpose;enabled:boolean;expectedRevision:string}|
 {kind:'public-label';expectedRevision:string;override:boolean|null};
export function validateReceptionPersonalizationAction(kind:'settings'|'history-grant'|'public-label',input:unknown):ReceptionPersonalizationAction {
 const v=object(input);if(!revision(v.expectedRevision))fail('invalid_payload');
 if(kind==='public-label'){
  exact(v,['expectedRevision','override']);if(v.override!==null&&typeof v.override!=='boolean')fail('invalid_payload');
  return {kind,expectedRevision:v.expectedRevision,override:v.override as boolean|null};
 }
 if(kind==='settings'){
  exact(v,['expectedRevision','draftTone','automaticTone','learnFromHuman','timing']);
  if(typeof v.learnFromHuman!=='boolean')fail('invalid_payload');
  try{return {kind,expectedRevision:v.expectedRevision,settings:{draftTone:parseReceptionTone(v.draftTone),automaticTone:parseReceptionTone(v.automaticTone),learnFromHuman:v.learnFromHuman,timing:parseReceptionTiming(v.timing)}};}
  catch{fail('invalid_payload');}
 }
 if(!purpose(v.purpose)||typeof v.enabled!=='boolean')fail('invalid_payload');
 exact(v,v.enabled?['expectedRevision','purpose','enabled','confirmed','disclosureVersion']:['expectedRevision','purpose','enabled']);
 if(v.enabled&&(v.confirmed!==true||v.disclosureVersion!==RECEPTION_HISTORY_DISCLOSURES[v.purpose]))fail('history_confirmation_required');
 return {kind,expectedRevision:v.expectedRevision,purpose:v.purpose,enabled:v.enabled};
}
export const receptionPersonalizationSchema=`
 CREATE INDEX reception_history_customer_contacts ON channel_identities(tenant_id,customer_id,chatwoot_contact_id)
  WHERE sync_status='synced' AND chatwoot_contact_id IS NOT NULL;
 CREATE INDEX reception_history_contact_customers ON channel_identities(tenant_id,chatwoot_contact_id,customer_id)
  WHERE sync_status='synced' AND chatwoot_contact_id IS NOT NULL;
 CREATE TABLE reception_personalization_settings(
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id),revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
  draft_tone TEXT NOT NULL DEFAULT 'neutral' CHECK(draft_tone IN('concise','neutral','friendly_detailed')),
  automatic_tone TEXT NOT NULL DEFAULT 'neutral' CHECK(automatic_tone IN('concise','neutral','friendly_detailed')),
  learn_from_human BOOLEAN NOT NULL DEFAULT false,timing_enabled BOOLEAN NOT NULL DEFAULT true,
  minimum_seconds INTEGER NOT NULL DEFAULT 1 CHECK(minimum_seconds>=1),
  maximum_seconds INTEGER NOT NULL DEFAULT 30 CHECK(maximum_seconds<=120 AND maximum_seconds>minimum_seconds),
  actor_id UUID NOT NULL REFERENCES platform_users(platform_user_id),updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
 );
 CREATE TABLE reception_history_grants(
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),purpose TEXT NOT NULL CHECK(purpose IN('context','style','knowledgeDraft')),
  grant_id UUID NOT NULL UNIQUE,account_id BIGINT NOT NULL CHECK(account_id>0),revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),enabled BOOLEAN NOT NULL,
  disclosure_version TEXT NOT NULL,actor_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
  session_id UUID NOT NULL REFERENCES console_sessions(session_id),confirmed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,purpose),CHECK(disclosure_version=CASE purpose
   WHEN 'context' THEN 'reception-history-context-v1' WHEN 'style' THEN 'reception-history-style-v1'
   WHEN 'knowledgeDraft' THEN 'reception-history-knowledge-draft-v1' END)
 );
 CREATE INDEX reception_history_enabled_page ON reception_history_grants(tenant_id,purpose) WHERE enabled;
 CREATE TABLE reception_learned_styles(
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id),
  lease_id UUID,lease_until TIMESTAMPTZ,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  profile_grant_id UUID,profile_account_id BIGINT,profile_settings_revision BIGINT,
  style JSONB,sample_digest TEXT,observed_at TIMESTAMPTZ,expires_at TIMESTAMPTZ,
  CHECK((lease_id IS NULL)=(lease_until IS NULL)),
  CHECK(style IS NULL OR (jsonb_typeof(style)='object' AND octet_length(style::text)<=1024)),
  CHECK(sample_digest IS NULL OR sample_digest ~ '^[a-f0-9]{64}$'),
  CHECK((style IS NULL AND profile_grant_id IS NULL AND profile_account_id IS NULL AND profile_settings_revision IS NULL
    AND sample_digest IS NULL AND observed_at IS NULL AND expires_at IS NULL) OR
   (style IS NOT NULL AND profile_grant_id IS NOT NULL AND profile_account_id IS NOT NULL AND profile_account_id>0
    AND profile_settings_revision IS NOT NULL AND profile_settings_revision>0
    AND sample_digest IS NOT NULL AND observed_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at>observed_at))
 );
 CREATE INDEX reception_style_due_page ON reception_learned_styles(next_attempt_at,tenant_id);
 CREATE TABLE reception_personalization_audit(
  audit_id UUID PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),actor_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
  session_id UUID NOT NULL REFERENCES console_sessions(session_id),action TEXT NOT NULL CHECK(action IN('settings.saved','history.enabled','history.revoked')),
  resource_id UUID,metadata JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK(jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=4096)
 );
 CREATE INDEX reception_personalization_audit_page ON reception_personalization_audit(tenant_id,created_at DESC,audit_id DESC);
 CREATE TABLE reception_personalization_rate(
  session_id UUID PRIMARY KEY REFERENCES console_sessions(session_id),bucket TIMESTAMPTZ NOT NULL,
  reads INTEGER NOT NULL DEFAULT 0 CHECK(reads BETWEEN 0 AND 121),writes INTEGER NOT NULL DEFAULT 0 CHECK(writes BETWEEN 0 AND 61)
 );
 CREATE FUNCTION guard_reception_personalization_revision() RETURNS trigger AS $$
 BEGIN
  IF TG_OP='INSERT' THEN
   IF NEW.revision<>1 THEN RAISE EXCEPTION 'initial revision must be one'; END IF;
  ELSE
   IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.revision IS DISTINCT FROM OLD.revision THEN
    RAISE EXCEPTION 'identity and revision are server controlled'; END IF;
   NEW.revision:=OLD.revision+1;
   IF TG_TABLE_NAME='reception_history_grants' THEN
    IF NEW.purpose IS DISTINCT FROM OLD.purpose THEN RAISE EXCEPTION 'history purpose is immutable'; END IF;
   END IF;
  END IF;
  RETURN NEW;
 END; $$ LANGUAGE plpgsql;
 CREATE TRIGGER reception_settings_revision BEFORE INSERT OR UPDATE ON reception_personalization_settings
  FOR EACH ROW EXECUTE FUNCTION guard_reception_personalization_revision();
 CREATE TRIGGER reception_history_revision BEFORE INSERT OR UPDATE ON reception_history_grants
  FOR EACH ROW EXECUTE FUNCTION guard_reception_personalization_revision();
 CREATE FUNCTION guard_reception_personalization_audit() RETURNS trigger AS $$
 BEGIN RAISE EXCEPTION 'personalization audit is append only'; END; $$ LANGUAGE plpgsql;
 CREATE TRIGGER reception_personalization_audit_guard BEFORE UPDATE OR DELETE ON reception_personalization_audit
  FOR EACH ROW EXECUTE FUNCTION guard_reception_personalization_audit();
 CREATE TRIGGER reception_personalization_audit_truncate_guard BEFORE TRUNCATE ON reception_personalization_audit
  FOR EACH STATEMENT EXECUTE FUNCTION guard_reception_personalization_audit();
`;
const defaults:ReceptionPersonalizationSettings=Object.freeze({revision:'0',draftTone:'neutral',automaticTone:'neutral',learnFromHuman:false,timing:defaultReceptionTiming});
function settingsView(row:any):ReceptionPersonalizationSettings {
 if(!row)return defaults;
 if(!revision(String(row.revision)))fail('personalization_result_uncertain',503);
 try{return Object.freeze({revision:String(row.revision),draftTone:parseReceptionTone(row.draft_tone),automaticTone:parseReceptionTone(row.automatic_tone),
  learnFromHuman:row.learn_from_human===true,timing:parseReceptionTiming({enabled:row.timing_enabled,minimumSeconds:row.minimum_seconds,maximumSeconds:row.maximum_seconds})});}
 catch{fail('personalization_result_uncertain',503);}
}
/** A worker must bind the grant id it actually read; rotated/revoked/stale grants
 * and a removed administrator fail closed. This does not authorize native reads.
 */
export async function currentReceptionHistoryGrant(c:Pick<PoolClient,'query'>,tenant:string,account:string,p:ReceptionHistoryPurpose,grantId:string):Promise<boolean> {
 if(!purpose(p)||!tenant||tenant.length>200||!/^\d{1,19}$/.test(account)||!/^[a-f0-9-]{36}$/.test(grantId))return false;
 const r=await c.query(`SELECT 1 FROM reception_history_grants g JOIN tenants t USING(tenant_id)
  JOIN platform_users u ON u.platform_user_id=g.actor_id
  JOIN tenant_memberships m ON m.tenant_id=g.tenant_id AND m.platform_user_id=g.actor_id
  WHERE g.tenant_id=$1 AND t.chatwoot_account_id::text=$2 AND g.account_id::text=$2 AND g.purpose=$3 AND g.grant_id=$4 AND g.enabled
   AND g.disclosure_version=$5 AND t.status IN('active','test') AND u.status='active' AND m.status='active' AND m.role='tenant_admin'
   AND m.chatwoot_sync_status='synced' AND m.chatwoot_account_id=g.account_id
   AND EXISTS(SELECT 1 FROM reception_personalization_audit a WHERE a.tenant_id=g.tenant_id AND a.resource_id=g.grant_id
    AND a.actor_id=g.actor_id AND a.session_id=g.session_id AND a.action='history.enabled'
    AND a.metadata->>'purpose'=g.purpose AND a.metadata->>'revision'=g.revision::text
    AND a.metadata->>'accountId'=g.account_id::text
    AND a.metadata->>'disclosureVersion'=g.disclosure_version)`,[tenant,account,p,grantId,RECEPTION_HISTORY_DISCLOSURES[p]]);
 return r.rowCount===1;
}
type Db=Pick<Pool,'connect'>;
/** Authenticated workspace is authoritative; no caller/model-selected tenant,
 * account, actor, grant id, SQL or transcript is accepted in mutation bodies.
 */
export async function manageReceptionPersonalization(db:Db,token:string,expectedTenant:string,action?:ReceptionPersonalizationAction){
 const c=await db.connect();try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='500ms'");
  const auth=await authenticateAutomaticAdministrator(c,token,{requireNativeAccount:false});
  if(!auth)fail('administrator_session_required',403);
  if(auth.tenant_id!==expectedTenant)fail('workspace_changed',409);
  const rate=(await c.query(`INSERT INTO reception_personalization_rate(session_id,bucket,reads,writes)
   VALUES($1,date_trunc('minute',clock_timestamp()),$2,$3) ON CONFLICT(session_id) DO UPDATE SET
   bucket=date_trunc('minute',clock_timestamp()),
   reads=CASE WHEN reception_personalization_rate.bucket=date_trunc('minute',clock_timestamp()) THEN LEAST(reception_personalization_rate.reads+$2,121) ELSE $2 END,
   writes=CASE WHEN reception_personalization_rate.bucket=date_trunc('minute',clock_timestamp()) THEN LEAST(reception_personalization_rate.writes+$3,61) ELSE $3 END
   RETURNING reads,writes`,[auth.session_id,action?0:1,action?1:0])).rows[0];
  if(action?rate.writes>60:rate.reads>120){await c.query('COMMIT');fail('rate_limited',429);}
  if(action)await c.query('SELECT pg_advisory_xact_lock(714207,hashtext($1))',[auth.tenant_id]);
  const settings=()=>c.query('SELECT *,revision::text FROM reception_personalization_settings WHERE tenant_id=$1',[auth.tenant_id]);
  const grants=()=>c.query('SELECT purpose,enabled,revision::text,disclosure_version,confirmed_at FROM reception_history_grants WHERE tenant_id=$1 ORDER BY purpose',[auth.tenant_id]);
  const audit=async(kind:string,resource:string|null,metadata:unknown)=>c.query(`INSERT INTO reception_personalization_audit(audit_id,tenant_id,actor_id,session_id,action,resource_id,metadata)
   VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),auth.tenant_id,auth.platform_user_id,auth.session_id,kind,resource,metadata]);
  if(action?.kind==='public-label'){
   if(process.env.AI_PUBLIC_LABEL_SETTINGS_ENABLED!=='true')fail('not_found',404);
   const old=await readPublicAiLabel(c,auth.tenant_id);
   if(old.revision!==action.expectedRevision)fail('personalization_revision_conflict',409);
   const saved=(await c.query(`INSERT INTO ai_public_label_settings(tenant_id,enabled,actor_id) VALUES($1,$2,$3)
    ON CONFLICT(tenant_id) DO UPDATE SET enabled=$2,actor_id=$3,updated_at=clock_timestamp() RETURNING revision::text`,
    [auth.tenant_id,action.override,auth.platform_user_id])).rows[0];
   await audit('settings.saved',null,{publicAiLabel:{revision:saved.revision,override:action.override,previous:old.override,
    platformDefault:old.platformDefault},scope:'visitor_display_only'});
  }else if(action?.kind==='settings'){
   const old=(await settings()).rows[0];if((old?.revision??'0')!==action.expectedRevision)fail('personalization_revision_conflict',409);
   const s=action.settings;
   if(s.learnFromHuman){
    const g=(await c.query(`SELECT grant_id FROM reception_history_grants WHERE tenant_id=$1 AND purpose='style'`,[auth.tenant_id])).rows[0];
    if(!g||!auth.account_id||!await currentReceptionHistoryGrant(c,auth.tenant_id,auth.account_id,'style',g.grant_id))fail('history_style_authorization_required',409);
   }
   const values=[auth.tenant_id,s.draftTone,s.automaticTone,s.learnFromHuman,s.timing.enabled,s.timing.minimumSeconds,s.timing.maximumSeconds,auth.platform_user_id];
   const saved=(await c.query(old?`UPDATE reception_personalization_settings SET draft_tone=$2,automatic_tone=$3,learn_from_human=$4,
    timing_enabled=$5,minimum_seconds=$6,maximum_seconds=$7,actor_id=$8,updated_at=clock_timestamp() WHERE tenant_id=$1 RETURNING revision::text`:
    `INSERT INTO reception_personalization_settings(tenant_id,draft_tone,automatic_tone,learn_from_human,timing_enabled,minimum_seconds,maximum_seconds,actor_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING revision::text`,values)).rows[0];
   await audit('settings.saved',null,{revision:saved.revision,...s});
  }else if(action?.kind==='history-grant'){
   if(action.enabled&&!await authenticateAutomaticAdministrator(c,token))fail('history_channel_unavailable',409);
   const old=(await c.query('SELECT revision::text,account_id::text FROM reception_history_grants WHERE tenant_id=$1 AND purpose=$2',[auth.tenant_id,action.purpose])).rows[0];
   if((old?.revision??'0')!==action.expectedRevision)fail('personalization_revision_conflict',409);
   if(!action.enabled&&!old)fail('personalization_revision_conflict',409);
   const grantId=randomUUID(),version=RECEPTION_HISTORY_DISCLOSURES[action.purpose],account=action.enabled?auth.account_id:old.account_id;
   const saved=(await c.query(`INSERT INTO reception_history_grants(tenant_id,purpose,grant_id,enabled,disclosure_version,actor_id,session_id,account_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,purpose) DO UPDATE SET grant_id=$3,enabled=$4,disclosure_version=$5,account_id=$8,
     actor_id=$6,session_id=$7,confirmed_at=clock_timestamp() RETURNING revision::text`,
    [auth.tenant_id,action.purpose,grantId,action.enabled,version,auth.platform_user_id,auth.session_id,account])).rows[0];
   await audit(action.enabled?'history.enabled':'history.revoked',grantId,{purpose:action.purpose,revision:saved.revision,disclosureVersion:version,accountId:account});
   if(!action.enabled&&action.purpose==='style'){
    const changed=(await c.query(`UPDATE reception_personalization_settings SET learn_from_human=false,actor_id=$2,updated_at=clock_timestamp()
     WHERE tenant_id=$1 AND learn_from_human RETURNING revision::text`,[auth.tenant_id,auth.platform_user_id])).rows[0];
    if(changed)await audit('settings.saved',null,{revision:changed.revision,learnFromHuman:false,reason:'history_style_revoked'});
   }
  }
  const value={settings:settingsView((await settings()).rows[0]),grants:(await grants()).rows,
   publicLabel:process.env.AI_PUBLIC_LABEL_SETTINGS_ENABLED==='true'?await readPublicAiLabel(c,auth.tenant_id):null,
   availability:{presentation:false,history:false},
   disclosures:Object.fromEntries(Object.entries(receptionHistoryDisclosures).map(([p,text])=>[p,{version:RECEPTION_HISTORY_DISCLOSURES[p as ReceptionHistoryPurpose],text}]))};
  await c.query('COMMIT');return value;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});if(e instanceof ReceptionPersonalizationError)throw e;throw new ReceptionPersonalizationError('personalization_result_uncertain',503);}
 finally{c.release();}
}
