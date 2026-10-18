import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Pool} from 'pg';
import {pool} from './database.js';
import {chunkText,contentChecksum} from './knowledge-ingestion.js';
import {lockKnowledgeCapacity} from './knowledge-capacity.js';
import {enqueueKnowledgeJob} from './knowledge-jobs.js';
import {EntitlementLimitError} from './subscriptions.js';
import {readBody,sendJson} from './shared.js';

type Auth={tenant_id:string;role:string;auth_kind?:string;actor_id?:string;impersonation_id?:string|null;session_scope?:string|null};
export class KnowledgeDraftError extends Error {}
/** Options are trusted server composition/test ports, never request fields. */
export async function manageKnowledgeDraft(auth:Auth,id:string,input:Record<string,unknown>|null,requestId:string,options:{db?:Pick<Pool,'connect'>;
 historyEnabled?:boolean;capacity?:typeof lockKnowledgeCapacity;enqueue?:typeof enqueueKnowledgeJob}={}){
 if(auth.auth_kind!=='console_session'||auth.role!=='tenant_admin'||!auth.actor_id||auth.impersonation_id||auth.session_scope==='copilot_embed')throw new KnowledgeDraftError('draft_forbidden');
 const c=await (options.db??pool).connect();
 try{
  await c.query('BEGIN');
  await c.query("SET LOCAL statement_timeout='3s';SET LOCAL lock_timeout='500ms'");
  const member=await c.query(`SELECT 1 FROM tenant_memberships m JOIN platform_users u USING(platform_user_id) JOIN tenants t USING(tenant_id)
   WHERE m.tenant_id=$1 AND m.platform_user_id=$2 AND m.role='tenant_admin' AND m.status='active' AND u.status='active' AND t.status IN ('active','test') FOR SHARE OF m,u,t`,[auth.tenant_id,auth.actor_id]);
  if(!member.rowCount)throw new KnowledgeDraftError('draft_forbidden');
  const history=options.historyEnabled===true;
  const row=(await c.query(`SELECT d.document_id,d.title,d.content,d.version,d.status,d.file_size,d.content_checksum,
   ${history?`CASE WHEN h.job_id IS NOT NULL THEN '' ELSE i.license_text END license_text,
    CASE WHEN h.job_id IS NOT NULL THEN '来自本企业公开历史聊天，经隐私处理；历史答案可能过期或有误，请核对、编辑并明确发布后使用。' ELSE i.source_note END source_note`:'i.license_text,i.source_note'}
   FROM knowledge_documents d ${history?'LEFT':'INNER'} JOIN template_market_imports i ON i.tenant_id=d.tenant_id AND i.imported_ids @> to_jsonb(ARRAY[d.document_id::text])
   ${history?"LEFT JOIN reception_history_knowledge_jobs h ON h.document_id=d.document_id AND h.tenant_id=d.tenant_id AND h.state='succeeded'":''}
   WHERE d.tenant_id=$1 AND d.document_id=$2 AND d.storage_key IS NULL AND d.content_format='text'
    AND d.scan_status='not_required' AND d.parse_status='ready' ${history?'AND (i.order_id IS NOT NULL OR h.job_id IS NOT NULL)':''} FOR UPDATE OF d`,[auth.tenant_id,id])).rows[0];
  if(!row)throw new KnowledgeDraftError('draft_not_found');
  if(!input){if(row.status!=='draft')throw new KnowledgeDraftError('draft_conflict');await c.query('COMMIT');return row;}
  if(!Number.isSafeInteger(input.expected_version)||input.expected_version!==row.version)throw new KnowledgeDraftError('draft_conflict');
  if(!['save','publish'].includes(String(input.action)))throw new KnowledgeDraftError('draft_invalid');
  if(input.action==='publish'&&input.confirmed!==true)throw new KnowledgeDraftError('draft_confirmation_required');
  if(row.status!=='draft'){
   const prior=await c.query("SELECT 1 FROM audit_logs WHERE tenant_id=$1 AND resource_id=$2 AND action='knowledge.draft.published'",[auth.tenant_id,id]);
   if(row.status==='active'&&input.action==='publish'&&prior.rowCount){await c.query('COMMIT');return {document_id:id,status:'active',idempotent_replay:true};}
   throw new KnowledgeDraftError('draft_conflict');
  }
  let version=row.version;
  if(input.action==='save'){
   if(typeof input.content!=='string'||!input.content.trim()||input.content.length>200000)throw new KnowledgeDraftError('draft_invalid');
   const content=input.content.trim(),bytes=Buffer.byteLength(content,'utf8');
   await (options.capacity??lockKnowledgeCapacity)(c,auth.tenant_id,Math.max(0,bytes-Number(row.file_size??Buffer.byteLength(row.content,'utf8'))));
   version++;
   await c.query('UPDATE knowledge_documents SET content=$3,file_size=$4,content_checksum=$5,version=$6,updated_at=NOW() WHERE tenant_id=$1 AND document_id=$2',[auth.tenant_id,id,content,bytes,contentChecksum(content),version]);
  }else{
   await (options.capacity??lockKnowledgeCapacity)(c,auth.tenant_id,0);
   const chunks=chunkText(row.content);if(!chunks.length)throw new KnowledgeDraftError('draft_invalid');
   const prior=await c.query('SELECT 1 FROM knowledge_chunks WHERE tenant_id=$1 AND document_id=$2',[auth.tenant_id,id]);if(prior.rowCount)throw new KnowledgeDraftError('draft_conflict');
   for(const [index,content] of chunks.entries())await c.query("INSERT INTO knowledge_chunks(tenant_id,document_id,document_version,chunk_index,content,embedding_status) VALUES($1,$2,$3,$4,$5,'pending')",[auth.tenant_id,id,version,index,content]);
   await c.query("UPDATE knowledge_documents SET status='active',ingestion_status='chunked',updated_at=NOW() WHERE tenant_id=$1 AND document_id=$2",[auth.tenant_id,id]);
   await (options.enqueue??enqueueKnowledgeJob)(auth.tenant_id,id,'embed_document',c);
  }
  await c.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
   VALUES($1,'platform_user',$2,$3,'knowledge_document',$4,$5,$6)`,[auth.tenant_id,auth.actor_id,input.action==='save'?'knowledge.draft.saved':'knowledge.draft.published',id,{version},requestId]);
  await c.query('COMMIT');return {document_id:id,status:input.action==='save'?'draft':'active',version,idempotent_replay:false};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function handleKnowledgeDraftApi(req:IncomingMessage,res:ServerResponse,url:URL,auth:Auth,requestId:string){
 const match=url.pathname.match(/^\/api\/v1\/ai\/knowledge\/documents\/([0-9a-f-]{36})\/draft$/i);if(!match)return false;
 try{
  if(!['GET','POST'].includes(req.method??'')){sendJson(res,405,{error:{code:'method_not_allowed'}});return true;}
  const input=req.method==='POST'?JSON.parse((await readBody(req)).toString()):null;
  if(req.method==='POST'&&(!input||typeof input!=='object'||Array.isArray(input)))throw new KnowledgeDraftError('draft_invalid');
  const data=await manageKnowledgeDraft(auth,match[1],input,requestId,{historyEnabled:process.env.AI_HISTORY_KNOWLEDGE_DRAFTS_ENABLED==='true'});res.setHeader('cache-control','no-store');sendJson(res,200,{data,request_id:requestId});
 }catch(e){const code=e instanceof KnowledgeDraftError?e.message:e instanceof EntitlementLimitError?'draft_capacity':e instanceof SyntaxError?'draft_invalid':'draft_unavailable';sendJson(res,code==='draft_forbidden'?403:code==='draft_not_found'?404:code==='draft_unavailable'?503:409,{error:{code},request_id:requestId});}return true;
}
