'use client';
import {useState} from 'react';
type Document={document_id:string;title:string;version:number};
export function StudioKnowledgePicker({busy,selection,onChange}:{busy:boolean;selection:string[];onChange:(ids:string[])=>void}){
 const [documents,setDocuments]=useState<Document[]>([]),[loaded,setLoaded]=useState(false),[cursor,setCursor]=useState<string|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
 async function load(next=false){setLoading(true);setError('');try{
  const r=await fetch('/api/extensions/knowledge-options'+(next&&cursor?'?'+new URLSearchParams({cursor}).toString():''),{cache:'no-store'});const v=await r.json();
  if(!r.ok)throw Error('知识文档列表暂不可用，请重新登录或稍后再试。');
  setDocuments(v.data.documents);setCursor(v.data.pagination.next_cursor);setLoaded(true);
 }catch(e){setError(e instanceof Error?e.message:'加载失败');}finally{setLoading(false);}}
 return <details className="mt-3 rounded-xl border p-3 text-sm"><summary className="cursor-pointer font-medium">参考企业知识库（可选，最多 3 份） · 已选 {selection.length} 份</summary>
  <p className="mt-2 text-xs text-slate-500">仅在本次生成时，将勾选文档的标题及前 1,200 字摘要发给 AI；不读取草稿、失效内容或历史聊天。摘要不是整篇文档。</p>
  <button type="button" className="mt-2 rounded-lg border px-3 py-2" disabled={busy||loading} onClick={()=>void load()}>{loaded?'刷新第一页文档':'加载文档供选择'}</button>
  <div className="mt-2 space-y-2">{documents.map(d=><label key={d.document_id} className="flex gap-2"><input type="checkbox" checked={selection.includes(d.document_id)} disabled={busy||loading||(!selection.includes(d.document_id)&&selection.length>=3)} onChange={e=>onChange(e.target.checked?[...selection,d.document_id]:selection.filter(id=>id!==d.document_id))}/>{d.title} · V{d.version}</label>)}</div>
  {cursor&&<button type="button" className="mt-2 rounded-lg border px-3 py-2" disabled={busy||loading} onClick={()=>void load(true)}>下一页文档</button>}
  {Boolean(selection.length)&&<button type="button" className="ml-2 mt-2 text-blue-700" disabled={busy} onClick={()=>onChange([])}>清空所选</button>}
  {loaded&&!documents.length&&<p className="mt-2 text-slate-500">本页暂无已发布知识，可继续翻页或先发布知识文档。</p>}
  {error&&<p role="alert" className="mt-2 text-red-700">{error}</p>}
 </details>;
}
