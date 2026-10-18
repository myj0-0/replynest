import type {Pool} from 'pg';
import {documentControlsEnabled} from './knowledge-document-core.js';
import {readableUploadFilename} from './upload-filename.js';
export const knowledgeListSchema=`CREATE INDEX IF NOT EXISTS knowledge_documents_listing_idx ON knowledge_documents(tenant_id,created_at DESC,document_id DESC);`;
export class KnowledgeCursorError extends Error {}
export async function listKnowledgePage(db:Pool,tenant:string,cursor?:string,kind?:string,expiring=false){
 if(kind&&!['long_term','temporary'].includes(kind))throw new KnowledgeCursorError('invalid_knowledge_kind');
 const selection=(kind??'all')+':'+(expiring?'expiring':'all');
 let time:string|null=null,id:string|null=null;
 if(cursor){try{
  if(cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(cursor))throw Error();
  const v=JSON.parse(Buffer.from(cursor,'base64url').toString());
  if(v.v!==1||v.tenant!==tenant||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v.time)||!Number.isFinite(Date.parse(v.time))||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v.id))throw Error();
  if((v.selection??'all:all')!==selection)throw Error();
  if(new Date(v.time).toISOString().slice(0,19)!==v.time.slice(0,19))throw Error();
  time=v.time;id=v.id;
 }catch{throw new KnowledgeCursorError('invalid_knowledge_cursor');}}
 const c=await db.connect();try{
  await c.query('BEGIN READ ONLY');await c.query("SET LOCAL statement_timeout='3s'");await c.query("SET LOCAL lock_timeout='500ms'");
  const rows=(await c.query(`WITH page AS MATERIALIZED (
   SELECT document_id,title,source_type,version,status,content_format,original_filename,
    ingestion_status,scan_status,parse_status,file_size,valid_from,valid_until,updated_at,created_at,tenant_id
    ${documentControlsEnabled()?',document_kind,scope,requires_human_approval,document_group_id':''}
   FROM knowledge_documents d WHERE tenant_id=$1 AND status<>'deleted'
    ${documentControlsEnabled()&&kind?`AND document_kind='${kind}'`:''}
    ${expiring?"AND status='active' AND valid_until>NOW() AND valid_until<=NOW()+INTERVAL '3 days'":''}
    ${documentControlsEnabled()&&!expiring?`AND NOT EXISTS(SELECT 1 FROM knowledge_documents n WHERE n.tenant_id=d.tenant_id AND n.document_group_id=d.document_group_id AND n.version>d.version AND n.status<>'deleted')`:''}
    ${time?'AND (created_at,document_id)<($2::timestamptz,$3::uuid)':''}
   ORDER BY created_at DESC,document_id DESC LIMIT 21)
  SELECT d.*,to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS page_time,
   ${documentControlsEnabled()?`(SELECT n.document_id FROM knowledge_documents n WHERE n.tenant_id=$1 AND n.document_group_id=d.document_group_id AND n.status<>'deleted' ORDER BY n.version DESC LIMIT 1) latest_document_id,
    (SELECT n.valid_until FROM knowledge_documents n WHERE n.tenant_id=$1 AND n.document_group_id=d.document_group_id AND n.status='active' ORDER BY n.version DESC LIMIT 1) published_valid_until,`:''}
   c.chunk_count,c.ready_chunk_count FROM page d CROSS JOIN LATERAL (
    SELECT COUNT(*)::int chunk_count,COUNT(*) FILTER(WHERE embedding_status='ready')::int ready_chunk_count
    FROM knowledge_chunks WHERE tenant_id=$1 AND document_id=d.document_id AND document_version=d.version
   ) c ORDER BY d.created_at DESC,d.document_id DESC`,time?[tenant,time,id]:[tenant])).rows;
  await c.query('COMMIT');const visible=rows.slice(0,20),last=visible.at(-1);
  const next=rows.length>20&&last?Buffer.from(JSON.stringify({v:1,tenant,time:last.page_time,id:last.document_id,selection})).toString('base64url'):null;
  return {data:visible.map(({page_time,tenant_id,...item})=>({...item,original_filename:item.original_filename?readableUploadFilename(item.original_filename):null})),pagination:{page_size:20,has_more:rows.length>20,next_cursor:next}};
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
