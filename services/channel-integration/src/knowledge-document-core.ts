export const documentControlsEnabled=()=>process.env.KNOWLEDGE_DOCUMENT_CONTROLS_ENABLED==='true';
export const scopeKeys={channels:'channel',sku_ids:'sku_id',product_batch_ids:'product_batch_id',campaign_ids:'campaign_id',customer_segments:'customer_segment',regions:'region'} as const;
export class KnowledgeDocumentError extends Error{}
export function documentSettings(input:Record<string,unknown>,now=new Date()){
 if(!['long_term','temporary'].includes(String(input.document_kind)))throw new KnowledgeDocumentError('invalid_document_kind');
 const parse=(value:unknown)=>{
  const v=value instanceof Date?value.toISOString():value;
  if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(v)||!Number.isFinite(Date.parse(v)))return null;
  const parts=v.slice(0,19).match(/\d+/g)!.map(Number),civil=new Date(Date.UTC(parts[0],parts[1]-1,parts[2],parts[3],parts[4],parts[5]??0)).toISOString();
  if(civil.slice(0,16)!==v.slice(0,16)||(parts[5]!==undefined&&civil.slice(17,19)!==v.slice(17,19)))return null;
  return new Date(v);
 };
 const from=parse(input.valid_from),until=parse(input.valid_until);
 if(!from||!until||until<=from||until<=now||until.getUTCFullYear()>2200)throw new KnowledgeDocumentError('invalid_document_period');
 const raw=input.scope??{};
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new KnowledgeDocumentError('invalid_document_scope');
 const scope:Record<string,string[]>={};
 for(const [key,value] of Object.entries(raw)){
  if(!Object.hasOwn(scopeKeys,key)||!Array.isArray(value)||value.length>20||value.some(x=>typeof x!=='string'||!x.trim()||x.length>80||/[\x00-\x1f\x7f]/.test(x)))throw new KnowledgeDocumentError('invalid_document_scope');
  if(value.length)scope[key]=[...new Set(value.map(x=>x.trim()))];
 }
 if(typeof input.requires_human_approval!=='boolean')throw new KnowledgeDocumentError('invalid_document_approval');
 return {document_kind:String(input.document_kind),valid_from:from.toISOString(),valid_until:until.toISOString(),scope,requires_human_approval:input.requires_human_approval};
}
/** Literal alias/context expressions supplied only by module composition, never request input. */
export function documentScopeSql(alias:string,context:string,automatic=false){
 if(!documentControlsEnabled())return '';
 if(!/^[a-z][a-z0-9_]*$/.test(alias)||!/^\$\d+::jsonb$/.test(context))throw Error('invalid_document_scope_sql');
 const mapping=Object.entries(scopeKeys).map(([k,v])=>`WHEN '${k}' THEN '${v}'`).join(' ');
 return `${automatic?` AND ${alias}.requires_human_approval=FALSE`:''} AND NOT EXISTS(
  SELECT 1 FROM jsonb_each(${alias}.scope) s WHERE jsonb_array_length(s.value)>0
   AND NOT COALESCE(s.value ? (${context}->>CASE s.key ${mapping} END),FALSE))`;
}
