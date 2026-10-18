import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {AUTOMATIC_SEND_CONSENT_VERSION} from './automatic-reply-policy.js';
import {authenticateAutomaticAdministrator} from './automatic-reception-auth.js';
import {writeAutomaticReceptionMode} from './automatic-reception-mode.js';
import {inspectAutomaticSender,automaticSenderError,type AutomaticSenderPort} from './automatic-sender.js';
import {AUTOMATIC_EVIDENCE_VERSION,AUTOMATIC_TOPICS,compactAutomaticText,type AutomaticTopic} from './automatic-reception-evidence.js';
import {SEMANTIC_KNOWLEDGE_SEND_DISCLOSURE_VERSION} from './automatic-knowledge-consent.js';

export const AUTOMATIC_SEND_DISCLOSURE_VERSION=SEMANTIC_KNOWLEDGE_SEND_DISCLOSURE_VERSION;
export const AUTOMATIC_SEND_DISCLOSURE='开启后将读取本企业的网站聊天新问题及相关已发布知识。通过检索安全处理完成、当前有效的知识库问答和长文段落，组织答复并独立核验来源。检索可能调用嵌入模型，生成和核验分别调用文本模型并消耗 AI 点数；即使未找到可用来源或最终转人工，已发生的实际用量仍会计费。不读取整库、客户档案或历史聊天；只将当前问题和有界相关原文送给模型。仅低风险、来源支持、条件完整、无冲突且达到接待阈值的内容可自动发送，不能保证任意长文都能自动回答。人工分配不停止 AI 接待，客服可对客户暂停 10 分钟或提前恢复；到期仅接待新问题，人工已回答的问题不重复回复。不确定或高风险问题交人工，不自动重发，可随时撤销。公众号仍须单独确认渠道授权，本授权不允许群发。';
export class AutomaticManagementError extends Error{constructor(public code:string,public status=400){super(code);}}
const fail=(code:string,status=400):never=>{throw new AutomaticManagementError(code,status);};
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:fail('invalid_payload');
const exact=(v:Record<string,unknown>,names:string[])=>{if(Object.keys(v).sort().join(',')!==[...names].sort().join(','))fail('invalid_payload');};
export const automaticUuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v);
const revision=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const iso=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export type AutomaticAnswerInput={document_id:string;document_version:number;topic:AutomaticTopic;answer_text:string;keywords:string[];question_texts:string[];valid_from:string;valid_until:string};
export function validateAutomaticAnswerInput(value:unknown):AutomaticAnswerInput{
 const v=object(value);exact(v,['document_id','document_version','topic','answer_text','keywords','question_texts','valid_from','valid_until']);
 if(!automaticUuid(v.document_id)||!Number.isInteger(v.document_version)||Number(v.document_version)<1||Number(v.document_version)>2147483647||
  !AUTOMATIC_TOPICS.includes(v.topic as AutomaticTopic)||typeof v.answer_text!=='string'||!v.answer_text.trim()||v.answer_text.length>4000||
  !Array.isArray(v.keywords)||v.keywords.length<1||v.keywords.length>12||v.keywords.some(k=>typeof k!=='string'||k.length>40||compactAutomaticText(k).length<2)||
  !Array.isArray(v.question_texts)||v.question_texts.length<1||v.question_texts.length>20||v.question_texts.some(q=>typeof q!=='string'||q.trim().length<2||q.length>1000)||
  !iso(v.valid_from)||!iso(v.valid_until)||Date.parse(v.valid_until)<=Date.parse(v.valid_from)||Date.parse(v.valid_until)-Date.parse(v.valid_from)>366*86400000)fail('invalid_payload');
 const keywords=(v.keywords as string[]).map(k=>k.trim()),questions=(v.question_texts as string[]).map(q=>q.trim());
 if(new Set(keywords.map(compactAutomaticText)).size!==keywords.length||new Set(questions.map(compactAutomaticText)).size!==questions.length)fail('invalid_payload');
 return {document_id:String(v.document_id),document_version:Number(v.document_version),topic:v.topic as AutomaticTopic,answer_text:(v.answer_text as string).trim(),
  keywords,question_texts:questions,valid_from:String(v.valid_from),valid_until:String(v.valid_until)};
}
export type AutomaticManagementAction={kind:'list';after:string|null;limit:number}|{kind:'grant';enabled:boolean;expected:string|null}|
 {kind:'create';answer:AutomaticAnswerInput}|{kind:'replace';id:string;expected:string;answer:AutomaticAnswerInput}|
 {kind:'approve'|'disable';id:string;expected:string};
export function validateAutomaticManagementAction(kind:'grant'|'create'|'replace'|'approve'|'disable',value:unknown,id?:string):AutomaticManagementAction{
 const v=object(value);
 if(kind==='grant'){
  if(typeof v.enabled!=='boolean'||!(v.expected_authorization_id===null||automaticUuid(v.expected_authorization_id)))fail('invalid_payload');
  exact(v,v.enabled?['enabled','expected_authorization_id','confirmed','consent_version','disclosure_version']:['enabled','expected_authorization_id']);
  if(v.enabled&&(v.confirmed!==true||v.consent_version!==AUTOMATIC_SEND_CONSENT_VERSION||v.disclosure_version!==AUTOMATIC_SEND_DISCLOSURE_VERSION))fail('send_confirmation_required');
  return {kind,enabled:v.enabled as boolean,expected:v.expected_authorization_id as string|null};
 }
 if(kind==='create')return {kind,answer:validateAutomaticAnswerInput(v)};
 if(!automaticUuid(id)||!revision(v.expected_revision))fail('invalid_payload');
 if(kind==='replace'){exact(v,['expected_revision','answer']);return {kind,id:id!,expected:String(v.expected_revision),answer:validateAutomaticAnswerInput(v.answer)};}
 exact(v,kind==='approve'?['expected_revision','confirmed','approval_version']:['expected_revision']);
 if(kind==='approve'&&(v.confirmed!==true||v.approval_version!==AUTOMATIC_EVIDENCE_VERSION))fail('answer_confirmation_required');
 return {kind,id:id!,expected:String(v.expected_revision)};
}
/** Local-only migration; all authorization and audit changes share the caller's transaction. */
export const automaticManagementSchema=`
 ALTER TABLE automatic_reception_answers ADD COLUMN IF NOT EXISTS management_revision BIGINT NOT NULL DEFAULT 1 CHECK(management_revision>0);
 CREATE INDEX IF NOT EXISTS automatic_answers_management_page ON automatic_reception_answers(tenant_id,answer_id);
 CREATE INDEX IF NOT EXISTS automatic_sources_management_page ON knowledge_documents(tenant_id,document_id)
  WHERE status='active' AND ingestion_status='ready' AND parse_status IN('ready','parsed') AND scan_status IN('clean','not_required');
 CREATE OR REPLACE FUNCTION advance_automatic_answer_management_revision() RETURNS trigger AS $$
 BEGIN
  IF TG_OP='INSERT' THEN
   IF NEW.management_revision<>1 THEN RAISE EXCEPTION 'automatic answer initial revision must be one'; END IF;
  ELSE
   IF NEW.management_revision IS DISTINCT FROM OLD.management_revision THEN RAISE EXCEPTION 'automatic answer revision is server controlled'; END IF;
   NEW.management_revision:=OLD.management_revision+1;
  END IF;
  RETURN NEW;
 END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS automatic_answer_management_revision ON automatic_reception_answers;
 CREATE TRIGGER automatic_answer_management_revision BEFORE INSERT OR UPDATE ON automatic_reception_answers FOR EACH ROW EXECUTE FUNCTION advance_automatic_answer_management_revision();
 CREATE TABLE IF NOT EXISTS automatic_reception_management_audit(
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),actor_id UUID NOT NULL REFERENCES platform_users(platform_user_id),
  session_id UUID NOT NULL REFERENCES console_sessions(session_id),action TEXT NOT NULL CHECK(action IN('grant.enabled','grant.revoked','answer.created','answer.replaced','answer.approved','answer.disabled')),
  resource_id UUID NOT NULL,metadata JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK(jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=2048),
  CHECK(metadata-ARRAY['consent_version','disclosure_version','approval_version','revision','document_id','document_version','reply_hash']='{}'::jsonb)
 );
 CREATE INDEX IF NOT EXISTS automatic_management_audit_page ON automatic_reception_management_audit(tenant_id,created_at DESC,audit_id DESC);
 CREATE INDEX IF NOT EXISTS automatic_management_disclosure_lookup ON automatic_reception_management_audit(tenant_id,resource_id)
  WHERE action='grant.enabled';
 CREATE TABLE IF NOT EXISTS automatic_reception_management_rate(
  session_id UUID PRIMARY KEY REFERENCES console_sessions(session_id),bucket TIMESTAMPTZ NOT NULL,reads INTEGER NOT NULL DEFAULT 0,writes INTEGER NOT NULL DEFAULT 0
 );
 CREATE OR REPLACE FUNCTION protect_automatic_management_audit() RETURNS trigger AS $$
 BEGIN RAISE EXCEPTION 'automatic management audit is append only'; END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS automatic_management_audit_guard ON automatic_reception_management_audit;
 CREATE TRIGGER automatic_management_audit_guard BEFORE UPDATE OR DELETE ON automatic_reception_management_audit FOR EACH ROW EXECUTE FUNCTION protect_automatic_management_audit();
 DROP TRIGGER IF EXISTS automatic_management_audit_truncate_guard ON automatic_reception_management_audit;
 CREATE TRIGGER automatic_management_audit_truncate_guard BEFORE TRUNCATE ON automatic_reception_management_audit FOR EACH STATEMENT EXECUTE FUNCTION protect_automatic_management_audit();
`;
/** A verified bearer selects the workspace; no tenant/account/actor parameters from a client or model.
 * Lock real session, user, membership and tenant rows until commit; no production pool imports.
 */
type ManagementOptions={wechat?:boolean;sender?:AutomaticSenderPort};
type PreparedIdentity={tenant_id:string;account_id:string;platform_user_id:string;session_id:string};
/** Validate and release all authorization locks BEFORE calling the native server.
 * Initialization can succeed while a later grant fails. Such an actor has no
 * sending authority; the fresh transaction below must still approve everything.
 */
async function prepareSender(db:Pick<Pool,'connect'>,token:string,action:Extract<AutomaticManagementAction,{kind:'grant'}>,expectedTenant:string|undefined,sender:AutomaticSenderPort|undefined):Promise<PreparedIdentity>{
 const c=await db.connect();let auth:PreparedIdentity;
 try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3000ms'; SET LOCAL lock_timeout='500ms'");
  const verified=await authenticateAutomaticAdministrator(c,token);
  if(!verified)fail('administrator_session_required',403);
  if(expectedTenant!==undefined&&verified.tenant_id!==expectedTenant)fail('workspace_changed',409);
  const grant=(await c.query('SELECT authorization_id FROM automatic_reception_grants WHERE tenant_id=$1',[verified.tenant_id])).rows[0];
  if((grant?.authorization_id??null)!==action.expected)fail('authorization_conflict',409);
  auth=verified;await c.query('COMMIT');
 }catch(error){await c.query('ROLLBACK').catch(()=>{});if(error instanceof AutomaticManagementError)throw error;fail('management_result_uncertain',503);}
 finally{c.release();}
 let state;try{state=sender?await sender.prepare(auth!.account_id):'unavailable' as const;}catch{state='unavailable' as const;}
 if(state!=='ready')fail(automaticSenderError(state),503);
 return auth!;
}
export async function manageAutomaticReception(db:Pick<Pool,'connect'>,token:string,action:AutomaticManagementAction,expectedTenant?:string,options:ManagementOptions={}){
 if(!/^[a-f0-9]{64}$/.test(token))fail('unauthorized',401);
 const prepared=action.kind==='grant'&&action.enabled?await prepareSender(db,token,action,expectedTenant,options.sender):undefined;
 const result=await manageAutomaticReceptionTransaction(db,token,action,expectedTenant,options,prepared);
 // The transaction's finally has released its connection. Listing remains
 // available during native failure, without pretending a grant can execute.
 if(action.kind==='list')return {...result.value,execution:{sender_state:await inspectAutomaticSender(options.sender,result.accountId)}};
 return result.value;
}
async function manageAutomaticReceptionTransaction(db:Pick<Pool,'connect'>,token:string,action:AutomaticManagementAction,expectedTenant:string|undefined,options:ManagementOptions,prepared?:PreparedIdentity){
 if(!/^[a-f0-9]{64}$/.test(token))fail('unauthorized',401);
 const c=await db.connect();
 try{
  await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3000ms'; SET LOCAL lock_timeout='500ms'");
  const auth=await authenticateAutomaticAdministrator(c,token);
  if(!auth)fail('administrator_session_required',403);
  if(expectedTenant!==undefined&&auth.tenant_id!==expectedTenant)fail('workspace_changed',409);
  if(prepared&&(auth.tenant_id!==prepared.tenant_id||auth.account_id!==prepared.account_id||
   auth.platform_user_id!==prepared.platform_user_id||auth.session_id!==prepared.session_id))fail('workspace_changed',409);
  if(action.kind==='list'){
   if(!Number.isInteger(action.limit)||action.limit<1||action.limit>25||!(action.after===null||automaticUuid(action.after)))fail('invalid_payload');
   const grant=(await c.query(`SELECT g.authorization_id,g.consent_version,g.enabled,g.updated_at,
    (g.enabled AND EXISTS(SELECT 1 FROM automatic_reception_management_audit a WHERE a.tenant_id=g.tenant_id
      AND a.resource_id=g.authorization_id AND a.action='grant.enabled' AND a.actor_id::text=g.actor_id
      AND a.metadata->>'disclosure_version'=$3 AND a.metadata->>'consent_version'=g.consent_version)) knowledge_confirmed
    FROM automatic_reception_grants g WHERE g.tenant_id=$1 AND g.account_id=$2`,[auth.tenant_id,auth.account_id,AUTOMATIC_SEND_DISCLOSURE_VERSION])).rows[0]??null;
   const rows:unknown[]=[]; // Retired exact-answer records remain private audit history.
   const wechat=options.wechat?await (await import('./automatic-wechat-management.js')).readAutomaticWeChatGrant(c,auth.tenant_id):undefined;
   await c.query('COMMIT');return {accountId:auth.account_id,value:{grant,...(wechat?{wechat}:{}),answers:rows.slice(0,action.limit),next_cursor:null,
    knowledge_available:process.env.AI_RECEPTION_KNOWLEDGE_ANSWERS_ENABLED==='true',
    semantic_available:process.env.AI_RECEPTION_SEMANTIC_ANSWERS_ENABLED==='true',
    disclosure_version:AUTOMATIC_SEND_DISCLOSURE_VERSION,disclosure:AUTOMATIC_SEND_DISCLOSURE,consent_version:AUTOMATIC_SEND_CONSENT_VERSION,approval_version:AUTOMATIC_EVIDENCE_VERSION,channels:['web_chat']}};
  }
  // Serialize management mutations. Runtime readers may still hold grant/source guards.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`automatic-management:${auth.tenant_id}`]);
  const audit=async(event:string,id:string,metadata:unknown)=>c.query(`INSERT INTO automatic_reception_management_audit(tenant_id,actor_id,session_id,action,resource_id,metadata) VALUES($1,$2,$3,$4,$5,$6)`,[auth.tenant_id,auth.platform_user_id,auth.session_id,event,id,metadata]);
  if(action.kind==='grant'){
   const current=(await c.query('SELECT authorization_id FROM automatic_reception_grants WHERE tenant_id=$1 FOR UPDATE',[auth.tenant_id])).rows[0];
   if((current?.authorization_id??null)!==action.expected)fail('authorization_conflict',409);
   const id=randomUUID();
   const grant=(await c.query(`INSERT INTO automatic_reception_grants(tenant_id,account_id,authorization_id,consent_version,enabled,actor_id,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) ON CONFLICT(tenant_id) DO UPDATE SET account_id=EXCLUDED.account_id,authorization_id=EXCLUDED.authorization_id,
    consent_version=EXCLUDED.consent_version,enabled=EXCLUDED.enabled,actor_id=EXCLUDED.actor_id,updated_at=EXCLUDED.updated_at RETURNING authorization_id,enabled,consent_version,updated_at`,
    [auth.tenant_id,auth.account_id,id,AUTOMATIC_SEND_CONSENT_VERSION,action.enabled,auth.platform_user_id])).rows[0];
   await writeAutomaticReceptionMode(c,auth.tenant_id,auth.platform_user_id,action.enabled);
   await audit(action.enabled?'grant.enabled':'grant.revoked',id,{consent_version:AUTOMATIC_SEND_CONSENT_VERSION,...(action.enabled?{disclosure_version:AUTOMATIC_SEND_DISCLOSURE_VERSION}:{})});
   await c.query('COMMIT');return {accountId:auth.account_id,value:{grant}};
  }
  return fail('exact_answers_retired',410);
 }catch(error){await c.query('ROLLBACK').catch(()=>{});if(error instanceof AutomaticManagementError)throw error;throw new AutomaticManagementError('management_result_uncertain',503);}
 finally{c.release();}
}
