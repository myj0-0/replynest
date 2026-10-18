import type {PoolClient} from 'pg';
import {documentScopeSql,documentControlsEnabled} from './knowledge-document-core.js';
import {ExtensionError} from './extension-core.js';
export function knowledgeSelection(raw:unknown,confirmed:unknown):string[]{
 if(raw===undefined)return [];
 if(!Array.isArray(raw)||!raw.length||raw.length>3||new Set(raw).size!==raw.length||raw.some(id=>typeof id!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)))throw new ExtensionError('invalid_knowledge_selection');
 if(confirmed!==true)throw new ExtensionError('knowledge_confirmation_required',403);
 return raw as string[];
}
export async function studioKnowledge(c:Pick<PoolClient,'query'>,tenant:string,ids:string[]){
 if(!ids.length)return [];
 const rows=(await c.query(`SELECT document_id::text,title,version,left(content,1200) AS content
 FROM knowledge_documents WHERE tenant_id=$1 AND document_id=ANY($2::uuid[]) AND status='active'
 AND scan_status IN ('not_required','clean') AND parse_status='ready'
 AND (valid_from IS NULL OR valid_from<=NOW()) AND (valid_until IS NULL OR valid_until>NOW())
 ${documentScopeSql('knowledge_documents','$3::jsonb')}
 ORDER BY document_id`,[tenant,ids,...(documentControlsEnabled()?['{}']:[])])).rows;
 if(rows.length!==ids.length)throw new ExtensionError('knowledge_source_unavailable',409);
 return rows.map(r=>({document_id:r.document_id,title:String(r.title).slice(0,200),version:r.version,content:r.content}));
}
