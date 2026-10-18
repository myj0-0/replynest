export type KnowledgeStateDocument={status:string;scan_status:string;parse_status:string;ingestion_status:string;original_filename:string|null;ready_chunk_count:number;chunk_count:number;valid_from?:string|null;valid_until?:string|null};
export function knowledgeState(document:KnowledgeStateDocument,en=false){
 const managedDraft=document.status==='draft'&&document.ingestion_status==='managed_draft';
 const marketDraft=!managedDraft&&document.status==='draft'&&document.scan_status==='not_required'&&document.parse_status==='ready';
 const uploadDraft=document.status==='draft'&&document.scan_status==='clean'&&document.parse_status==='parsed'&&!!document.original_filename;
 const failed=[document.ingestion_status,document.scan_status,document.parse_status].some(v=>['failed','infected','blocked','rejected'].includes(v));
 const readable=['clean','not_required'].includes(document.scan_status)&&['parsed','ready'].includes(document.parse_status)&&['active','inactive'].includes(document.status);
 const expired=!!document.valid_until&&Date.parse(document.valid_until)<=Date.now(),scheduled=!!document.valid_from&&Date.parse(document.valid_from)>Date.now();
 const complete=document.status==='active'&&!expired&&!scheduled&&!failed&&document.chunk_count>0&&document.ready_chunk_count===document.chunk_count;
 const states:Record<string,[string,string]>={queued:['等待处理','Queued'],parsed:['已解析，索引尚未完成','Parsed; indexing incomplete'],ready:['已就绪','Ready'],indexed:['已就绪','Ready'],failed:['处理失败，请重试或联系客服','Processing failed; retry or contact support'],rejected:['文件未通过安全检查','File rejected'],ocr_required:['需要文字识别','OCR required']};
 const label=managedDraft?(en?'Unpublished draft':'草稿，尚未发布'):marketDraft?(en?'Draft awaiting review':'草稿待核对'):document.status==='inactive'?(en?'Historical / inactive version':'历史／已停用版本'):expired?(en?'Expired; retained for history':'已到期，保留历史'):scheduled?(en?'Not yet effective':'尚未生效'):(states[document.ingestion_status]?.[en?1:0]??document.ingestion_status);
 return {marketDraft,uploadDraft,failed,readable,complete,label,previewHint:uploadDraft?(en?'Indexing is incomplete; this upload is not published.':'索引尚未完成，此文件尚未发布。'):(en?'Preview becomes available after safe processing':'完成安全处理后可预览')};
}
