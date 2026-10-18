'use client';
import {useState} from 'react';
type Draft={document_id:string;title:string;content:string;version:number;license_text:string;source_note:string};
export function KnowledgeDraftEditor({draft,en=false}:{draft:Draft;en?:boolean}){
 const [content,setContent]=useState(draft.content),[saved,setSaved]=useState(draft.content),[version,setVersion]=useState(draft.version),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[published,setPublished]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 async function submit(action:'save'|'publish'){
  setBusy(true);setError('');setMessage('');try{const r=await fetch(`/api/knowledge/documents/${draft.document_id}/draft`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,expected_version:version,...(action==='save'?{content}:{confirmed})})});const data=await r.json();if(!r.ok){const code=data.error?.code;throw Error(code==='draft_conflict'?(en?'The version changed. Reload before editing.':'版本已变化，请刷新核对后再操作。'):code==='draft_capacity'?(en?'Knowledge capacity exceeded.':'知识库容量不足，请调整内容或套餐。'):(en?'Operation failed. Reload and check the current status.':'操作未完成，请刷新核对当前状态。'));}if(action==='save'){setVersion(data.data.version);setSaved(content.trim());setContent(content.trim());setConfirmed(false);setMessage(en?'Draft saved. No indexing or AI call was started.':'草稿已保存，未启动索引或 AI 调用。');}else{setPublished(true);setMessage(en?'Published and queued for indexing. Check processing status in the knowledge base.':'已确认发布并加入索引队列，请返回知识库查看处理状态。');}}catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <section className="mt-6 space-y-4 rounded-2xl border bg-white p-5">
  <p className="text-sm text-slate-500">{en?'Saved version':'已保存版本'}：V{version}</p>
  <p className="text-sm text-amber-800">{en?'Review tenant-specific promises and remove placeholders before publishing. Saving does not call AI; publishing queues indexing and may incur configured model charges.':'请核对本企业政策、服务承诺并替换占位内容。保存不调用 AI；确认发布才会启动索引，可能产生配置模型的调用费用。'}</p>
  <details className="rounded-xl bg-slate-50 p-3 text-sm"><summary>{en?'Source and terms of use':'来源与使用说明'}</summary><p className="mt-2 whitespace-pre-wrap">{draft.source_note}</p><p className="mt-2 whitespace-pre-wrap">{draft.license_text}</p></details>
  {!published&&<><label className="block text-sm font-medium">{en?'Draft content':'草稿正文'}<textarea value={content} onChange={e=>{setContent(e.target.value);setConfirmed(false);}} disabled={busy} maxLength={200000} className="mt-2 min-h-72 w-full rounded-xl border p-3 leading-7"/></label>
  <button onClick={()=>submit('save')} disabled={busy||!content.trim()||content===saved} className="rounded-xl border px-4 py-2 disabled:opacity-40">{en?'Save draft':'保存草稿'}</button>
  <label className="block text-sm"><input type="checkbox" checked={confirmed} disabled={busy||content!==saved} onChange={e=>setConfirmed(e.target.checked)}/> {en?'I reviewed the saved content and license and agree to publish and start indexing.':'我已核对已保存的正文和许可，确认发布并启动索引。'}</label>
  {content!==saved&&<p className="text-sm text-amber-800">{en?'Save your changes before publishing.':'请先保存修改，再确认发布。'}</p>}
  <button onClick={()=>submit('publish')} disabled={busy||!confirmed||content!==saved} className="rounded-xl bg-blue-600 px-4 py-2 text-white disabled:opacity-40">{en?'Publish and queue indexing':'确认发布并建立索引'}</button></>}
  {error&&<p role="alert" className="text-red-700">{error}</p>}{message&&<p role="status" className="text-green-700">{message}</p>}
  {published&&<a href="/knowledge" className="inline-block text-blue-700">{en?'Return to knowledge base':'返回知识库查看处理进度'}</a>}
 </section>;
}
