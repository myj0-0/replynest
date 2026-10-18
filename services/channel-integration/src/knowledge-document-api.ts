import {randomUUID,createHash} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {pool} from './database.js';
import {readBody,sendJson} from './shared.js';
import {chunkText,contentChecksum} from './knowledge-ingestion.js';
import {lockKnowledgeCapacity} from './knowledge-capacity.js';
import {enqueueKnowledgeJob} from './knowledge-jobs.js';
import {EntitlementLimitError} from './subscriptions.js';
import {documentControlsEnabled,documentSettings,KnowledgeDocumentError} from './knowledge-document-core.js';
type Auth={tenant_id:string;role:string;auth_kind?:string;actor_id?:string;impersonation_id?:string|null;session_scope?:string|null};
export async function handleKnowledgeDocumentApi(req:IncomingMessage,res:ServerResponse,url:URL,a:Auth,requestId:string){
 const create=url.pathname==='/api/v1/ai/knowledge/managed';
 const match=url.pathname.match(/^\/api\/v1\/ai\/knowledge\/documents\/([0-9a-f-]{36})\/manage(?:\/(history))?$/i);
 if(!create&&!match)return false;
 res.setHeader('cache-control','no-store');
 const reply=(status:number,data:unknown)=>sendJson(res,status,{request_id:requestId,data});
 const fail=(code:string,status=409)=>sendJson(res,status,{request_id:requestId,error:{code}});
 if(!documentControlsEnabled()){fail('document_management_unavailable',503);return true;}
 if(a.auth_kind!=='console_session'||a.session_scope==='copilot_embed'||a.impersonation_id||!a.actor_id){fail('document_forbidden',403);return true;}
 const id=match?.[1];
 try{
  if(req.method==='GET'&&id){
   const row=(await pool.query(`SELECT d.*,NOT EXISTS(SELECT 1 FROM knowledge_documents n WHERE n.tenant_id=d.tenant_id AND n.document_group_id=d.document_group_id AND n.version>d.version AND n.status<>'deleted') is_latest
    FROM knowledge_documents d WHERE d.tenant_id=$1 AND d.document_id=$2 AND d.status<>'deleted' AND d.scan_status IN('clean','not_required') AND d.parse_status IN('ready','parsed')`,[a.tenant_id,id])).rows[0];
   if(!row)throw new KnowledgeDocumentError('document_not_found');
   if(match?.[2]){
    const cursor=url.searchParams.get('before');if(cursor&&!/^[1-9]\d{0,8}$/.test(cursor))throw new KnowledgeDocumentError('invalid_history_cursor');
    const rows=(await pool.query(`SELECT document_id,title,version,status,document_kind,valid_from,valid_until,updated_at FROM knowledge_documents
     WHERE tenant_id=$1 AND document_group_id=$2 AND version<$3 AND status<>'deleted' ORDER BY version DESC LIMIT 11`,[a.tenant_id,row.document_group_id??id,cursor?Number(cursor):2147483647])).rows;
    reply(200,{versions:rows.slice(0,10),next_cursor:rows.length>10?String(rows[9].version):null});return true;
   }
   // No storage paths, binary sources, keys or unbounded document body in the editor projection.
   const {title,version,status,source_type,document_kind,valid_from,valid_until,scope,requires_human_approval,is_latest,keywords}=row;
   if(row.content.length>200000)throw new KnowledgeDocumentError('document_too_large_to_edit');
   reply(200,{document_id:id,title,version,status,source_type,document_kind,valid_from,valid_until,scope,requires_human_approval,is_latest,keywords,content:row.content});return true;
  }
  if(req.method!=='POST'||match?.[2]){fail('method_not_allowed',405);return true;}
  if(a.role!=='tenant_admin')throw new KnowledgeDocumentError('document_forbidden');
  const key=req.headers['idempotency-key'];if(typeof key!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(key))throw new KnowledgeDocumentError('document_idempotency_required');
  const input=JSON.parse((await readBody(req)).toString('utf8'));if(!input||typeof input!=='object'||Array.isArray(input))throw new KnowledgeDocumentError('document_invalid');
  const action=String(input.action??'save');if(!['save','publish','pause'].includes(action)||create&&action!=='save')throw new KnowledgeDocumentError('document_invalid');
  if(action==='publish'&&input.confirmed!==true)throw new KnowledgeDocumentError('document_confirmation_required');
  const signature=createHash('sha256').update(JSON.stringify({actor:a.actor_id,id:id??null,input})).digest('hex');
  const endpoint='knowledge-managed:'+signature;
  const c=await pool.connect();
  try{
   await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'");
   const member=await c.query(`SELECT 1 FROM tenant_memberships m JOIN platform_users u USING(platform_user_id) JOIN tenants t USING(tenant_id)
    WHERE m.tenant_id=$1 AND m.platform_user_id=$2 AND m.role='tenant_admin' AND m.status='active' AND u.status='active' AND t.status IN('active','test') FOR SHARE OF m,u,t`,[a.tenant_id,a.actor_id]);
   if(!member.rowCount)throw new KnowledgeDocumentError('document_forbidden');
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[a.tenant_id+':managed:'+key]);
   const prior=(await c.query('SELECT endpoint,response_status,response_body FROM idempotency_requests WHERE tenant_id=$1 AND idempotency_key=$2',[a.tenant_id,key])).rows[0];
   if(prior){if(prior.endpoint!==endpoint)throw new KnowledgeDocumentError('document_idempotency_conflict');await c.query('COMMIT');sendJson(res,prior.response_status,prior.response_body);return true;}
   const current=id?(await c.query(`SELECT * FROM knowledge_documents WHERE tenant_id=$1 AND document_id=$2 AND status<>'deleted'`,[a.tenant_id,id])).rows[0]:null;
   if(id&&!current)throw new KnowledgeDocumentError('document_not_found');
   if(current&&(input.expected_version!==current.version||!['clean','not_required'].includes(current.scan_status)||!['ready','parsed'].includes(current.parse_status)))throw new KnowledgeDocumentError('document_conflict');
   const title=action==='save'?String(input.title??'').trim():current?.title;
   if(!title||title.length>200||/[\x00-\x1f]/.test(title))throw new KnowledgeDocumentError('document_invalid');
   if(current&&title!==current.title)throw new KnowledgeDocumentError('document_title_immutable');
   for(const t of [...new Set([title,current?.title].filter(Boolean))].sort())await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[a.tenant_id+':'+t]);
   const group=current?.document_group_id??current?.document_id;
   if(current){
    if(!current.document_group_id)await c.query('UPDATE knowledge_documents SET document_group_id=$3 WHERE tenant_id=$1 AND title=$2 AND document_group_id IS NULL',[a.tenant_id,title,group]);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[a.tenant_id+':knowledge-group:'+group]);
    const latest=await c.query(`SELECT 1 FROM knowledge_documents WHERE tenant_id=$1 AND document_group_id=$2 AND version>$3 AND status<>'deleted'`,[a.tenant_id,group,current.version]);
    if(latest.rowCount)throw new KnowledgeDocumentError('document_conflict');
    const fresh=(await c.query('SELECT status,version FROM knowledge_documents WHERE tenant_id=$1 AND document_id=$2 FOR UPDATE',[a.tenant_id,id])).rows[0];
    if(fresh.status!==current.status||fresh.version!==current.version)throw new KnowledgeDocumentError('document_conflict');
    if(action!=='pause'&&(await c.query("SELECT 1 FROM knowledge_jobs WHERE tenant_id=$1 AND document_id=$2 AND (status IN('queued','running') OR (status='failed' AND attempts<max_attempts))",[a.tenant_id,id])).rowCount)throw new KnowledgeDocumentError('document_processing_busy');
   }
   let data:Record<string,unknown>;
   if(action==='save'){
    const settings=documentSettings(input),content=typeof input.content==='string'?input.content.trim():'';
    if(!content||content.length>200000||Buffer.byteLength(content)>512*1024)throw new KnowledgeDocumentError('document_invalid');
    if(!Array.isArray(input.keywords)||input.keywords.length>30||input.keywords.some((k:unknown)=>typeof k!=='string'||k.trim().length<2||k.length>40))throw new KnowledgeDocumentError('invalid_document_keywords');
    const source=settings.document_kind==='temporary'?'temporary_policy_text':String(input.source_type??'knowledge');
    if(!['knowledge','faq','script','temporary_policy_text'].includes(source))throw new KnowledgeDocumentError('document_invalid');
    await lockKnowledgeCapacity(c,a.tenant_id,Buffer.byteLength(content));
    if(create&&(await c.query('SELECT 1 FROM knowledge_documents WHERE tenant_id=$1 AND title=$2 AND status<>\'deleted\'',[a.tenant_id,title])).rowCount)throw new KnowledgeDocumentError('document_title_exists');
    const version=Number((await c.query('SELECT COALESCE(MAX(version),0)+1 v FROM knowledge_documents WHERE tenant_id=$1 AND (title=$2 OR document_group_id=$3)',[a.tenant_id,title,group??null])).rows[0].v);
    const next=randomUUID();
    if(current?.status==='draft')await c.query("UPDATE knowledge_documents SET status='inactive',updated_at=NOW() WHERE tenant_id=$1 AND document_id=$2",[a.tenant_id,id]);
    await c.query(`INSERT INTO knowledge_documents(document_id,tenant_id,title,version,status,content,content_format,content_checksum,file_size,source_type,
     document_kind,valid_from,valid_until,scope,requires_human_approval,document_group_id,keywords,ingestion_status)
     VALUES($1,$2,$3,$4,'draft',$5,'text',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'managed_draft')`,
     [next,a.tenant_id,title,version,content,contentChecksum(content),Buffer.byteLength(content),source,settings.document_kind,settings.valid_from,settings.valid_until,settings.scope,settings.requires_human_approval,group??next,[...new Set(input.keywords.map((k:string)=>k.trim()))]]);
    data={document_id:next,version,status:'draft'};
   }else if(action==='publish'){
    if(!current||current.status!=='draft'||current.storage_key||current.ingestion_status!=='managed_draft')throw new KnowledgeDocumentError('document_conflict');
    documentSettings(current);await lockKnowledgeCapacity(c,a.tenant_id,0);
    await c.query("UPDATE knowledge_documents SET status='inactive',updated_at=NOW() WHERE tenant_id=$1 AND document_group_id=$2 AND status='active'",[a.tenant_id,group]);
    const chunks=chunkText(current.content);if(!chunks.length)throw new KnowledgeDocumentError('document_invalid');
    for(const [i,content] of chunks.entries())await c.query("INSERT INTO knowledge_chunks(tenant_id,document_id,document_version,chunk_index,content,embedding_status) VALUES($1,$2,$3,$4,$5,'pending')",[a.tenant_id,id,current.version,i,content]);
    await c.query("UPDATE knowledge_documents SET status='active',ingestion_status='chunked',updated_at=NOW() WHERE tenant_id=$1 AND document_id=$2",[a.tenant_id,id]);
    await enqueueKnowledgeJob(a.tenant_id,id!,'embed_document',c);data={document_id:id,version:current.version,status:'active',index_queued:true};
   }else{
    if(!current)throw new KnowledgeDocumentError('document_conflict');
    const paused=await c.query("UPDATE knowledge_documents SET status='inactive',updated_at=NOW() WHERE tenant_id=$1 AND document_group_id=$2 AND status='active' RETURNING document_id",[a.tenant_id,group]);
    if(!paused.rowCount)throw new KnowledgeDocumentError('document_not_active');data={document_id:id,version:current.version,status:current.status==='active'?'inactive':current.status};
   }
   await c.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
    VALUES($1,'platform_user',$2,$3,'knowledge_document',$4,$5,$6)`,[a.tenant_id,a.actor_id,'knowledge.managed.'+action,data.document_id,{version:data.version,status:data.status},requestId]);
   const body={request_id:requestId,data};await c.query('INSERT INTO idempotency_requests(tenant_id,idempotency_key,endpoint,response_status,response_body) VALUES($1,$2,$3,200,$4)',[a.tenant_id,key,endpoint,body]);
   await c.query('COMMIT');sendJson(res,200,body);
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }catch(e){const code=e instanceof KnowledgeDocumentError?e.message:e instanceof EntitlementLimitError?'document_capacity':e instanceof SyntaxError?'document_invalid':'document_unavailable';fail(code,code==='document_forbidden'?403:code==='document_not_found'?404:code==='document_unavailable'?503:409);}
 return true;
}
