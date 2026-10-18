import {createHash} from 'node:crypto';
import {chunkText} from './knowledge-ingestion.js';

export const AUTOMATIC_SEMANTIC_SOURCE_VERSION='published-knowledge-section-v1';
export const SEMANTIC_DIMENSIONS=768;
// Candidate recall only, never answer confidence or permission to send. The
// deployed synthetic FAQ scored 0.772 even for its exact question because the
// indexed section also contains its scope/conditions. Keep that full scope;
// independent claim/quote verification and the send threshold still apply.
export const SEMANTIC_MIN_SIMILARITY=0.70;
export const SEMANTIC_MAX_HITS=6,SEMANTIC_MAX_DOCUMENTS=3,SEMANTIC_CONTEXT_BYTES=24000;
export const semanticHash=(text:string)=>createHash('sha256').update(text).digest('hex');
export type SemanticKnowledgeHit={
 tenantId:string;documentId:string;documentVersion:number;currentDocumentVersion:number;
 chunkId:string;chunkIndex:number;chunkText:string;content:string;similarity:number;
};
export type SemanticKnowledgeProof={
 version:typeof AUTOMATIC_SEMANTIC_SOURCE_VERSION;documentId:string;documentVersion:number;
 chunkId:string;chunkIndex:number;documentHash:string;chunkHash:string;contextHash:string;
 ranges:Array<[number,number]>;
};
export type SemanticKnowledgeContext={proof:SemanticKnowledgeProof;text:string;similarity:number};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
/** Exact source provenance, not relevance/entailment approval. Returns a WHOLE
 * Markdown section plus global preamble, or the WHOLE unheaded document. Never
 * promote a sliced 800-character chunk into an answer, dropping its conditions.
 * Unsupported/oversized/ambiguous sources must be reviewed, not truncated. */
export function semanticKnowledgeContext(hit:SemanticKnowledgeHit,tenantId:string):SemanticKnowledgeContext|null{
 if(!hit||hit.tenantId!==tenantId||!uuid(hit.documentId)||!uuid(hit.chunkId)||
  !Number.isInteger(hit.documentVersion)||hit.documentVersion<1||hit.documentVersion!==hit.currentDocumentVersion||
  !Number.isInteger(hit.chunkIndex)||hit.chunkIndex<0||hit.chunkIndex>=2000||typeof hit.content!=='string'||!hit.content.trim()||hit.content.length>120000||
  typeof hit.chunkText!=='string'||!hit.chunkText.trim()||hit.chunkText.length>2000||
  !Number.isFinite(hit.similarity)||hit.similarity<SEMANTIC_MIN_SIMILARITY||hit.similarity>1)return null;
 const chunks=chunkText(hit.content);
 if(chunks[hit.chunkIndex]!==hit.chunkText)return null;
 const content=hit.content.replace(/\r\n/g,'\n');
 const position=content.indexOf(hit.chunkText);
 // Repeated fragments do not prove which scope contains this canonical chunk.
 if(position<0||content.indexOf(hit.chunkText,position+1)>=0)return null;
 if(/^ {0,3}(?:```|~~~)/m.test(content))return null; // no guessed Markdown scope inside code fences
 const headings=[...content.matchAll(/^ {0,3}(#{1,6})[ \t]+[^\n]+$/gm)].map(m=>({start:m.index!,level:m[1].length}));
 const prior=headings.filter(h=>h.start<=position),heading=prior.at(-1);
 const ranges:Array<[number,number]>=[];
 if(heading){
  const end=headings.find(h=>h.start>position&&h.level<=heading.level)?.start??content.length;
  if(position+hit.chunkText.length>end)return null; // chunk crosses section boundary
  const ancestors:typeof headings=[];
  // Include all ancestor scopes, not just the nearest subheading. Do not infer
  // qualifiers from titles alone or omit a parent introduction.
  for(let n=prior.length-2,level=heading.level;n>=0;n--)if(prior[n].level<level){ancestors.unshift(prior[n]);level=prior[n].level;}
  if(headings[0].start)ranges.push([0,headings[0].start]);
  for(const a of ancestors)ranges.push([a.start,headings.find(h=>h.start>a.start)!.start]);
  ranges.push([heading.start,end]);
 }else{
  // An unheaded chunk could depend on a later condition: retain the whole doc.
  ranges.push([0,content.length]);
 }
 const text=ranges.map(([start,end])=>content.slice(start,end)).join('\n\n');
 if(!text.trim()||text.length>8000||Buffer.byteLength(text)>SEMANTIC_CONTEXT_BYTES)return null;
 const proof:SemanticKnowledgeProof={version:AUTOMATIC_SEMANTIC_SOURCE_VERSION,documentId:hit.documentId,documentVersion:hit.documentVersion,
  chunkId:hit.chunkId,chunkIndex:hit.chunkIndex,documentHash:semanticHash(hit.content),chunkHash:semanticHash(hit.chunkText),
  contextHash:semanticHash(text),ranges};
 return {proof,text,similarity:hit.similarity};
}
/** Every returned hit must be provable. Invalid hits/overflow are NOT silently
 * removed, as that could conceal conflicting scope or another current source. */
export function selectSemanticKnowledgeContexts(hits:SemanticKnowledgeHit[],tenantId:string):SemanticKnowledgeContext[]|null{
 if(!Array.isArray(hits)||hits.length>SEMANTIC_MAX_HITS)return null;
 const selected:SemanticKnowledgeContext[]=[],documents=new Set<string>(),seen=new Set<string>();
 for(const h of hits){
  const context=semanticKnowledgeContext(h,tenantId);if(!context)return null;
  documents.add(h.documentId);if(documents.size>SEMANTIC_MAX_DOCUMENTS)return null;
  const key=`${h.documentId}:${context.proof.contextHash}`;
  if(!seen.has(key)){selected.push(context);seen.add(key);}
 }
 if(Buffer.byteLength(JSON.stringify(selected))>SEMANTIC_CONTEXT_BYTES)return null;
 return selected;
}
export function validateSemanticVector(vector:unknown):vector is number[]{
 return Array.isArray(vector)&&vector.length===SEMANTIC_DIMENSIONS&&vector.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=1e6)&&vector.some(n=>n!==0);
}
/** Fresh DB rows must re-prove offsets/content/version before model generation
 * and again before sending. A provenance match alone never permits sending. */
export function revalidateSemanticContext(proof:SemanticKnowledgeProof,hit:SemanticKnowledgeHit,tenantId:string):SemanticKnowledgeContext|null{
 if(!proof||Object.keys(proof).sort().join(',')!==['version','documentId','documentVersion','chunkId','chunkIndex','documentHash','chunkHash','contextHash','ranges'].sort().join(','))return null;
 const current=semanticKnowledgeContext(hit,tenantId);
 return current&&Object.keys(current.proof).every(k=>JSON.stringify(current.proof[k as keyof SemanticKnowledgeProof])===JSON.stringify(proof[k as keyof SemanticKnowledgeProof]))?current:null;
}
