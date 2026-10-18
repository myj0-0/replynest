'use client';
import {useId,useRef,useState} from 'react';
import {Upload} from 'lucide-react';
export function KnowledgeFileUpload({en=false}:{en?:boolean}){
 const [kind,setKind]=useState('long_term'),[from,setFrom]=useState(''),[until,setUntil]=useState(''),[channels,setChannels]=useState<string[]>([]),[human,setHuman]=useState(false),[confirmed,setConfirmed]=useState(false);
 const fileInput=useRef<HTMLInputElement>(null),fileLabel=useId();
 const [selectedFile,setSelectedFile]=useState<File|null>(null),[fileError,setFileError]=useState(''),[submitting,setSubmitting]=useState(false);
 const iso=(v:string)=>{try{return v?new Date(v+':00+08:00').toISOString():'';}catch{return '';}};
 const validPeriod=!!iso(from)&&!!iso(until)&&Date.parse(iso(until))>Date.parse(iso(from))&&Date.parse(iso(until))>Date.now()&&new Date(iso(until)).getUTCFullYear()<=2200;
 const inputClass='mt-1 w-full rounded-xl border border-[var(--border-subtle)] bg-white px-3 py-2.5 text-sm';
 return <form action="/api/knowledge/files" method="post" encType="multipart/form-data" onSubmit={event=>{if(submitting||!validPeriod||!selectedFile||fileError){event.preventDefault();return;}setSubmitting(true);}} className="mt-4 grid gap-4 md:grid-cols-2">
  <label>{en?'Title (same title updates the document)':'文档标题（同标题上传形成新版本）'}<input name="title" required maxLength={200} className={inputClass}/></label>
  <label>{en?'Category':'文档类别'}<select value={kind} onChange={e=>{setKind(e.target.value);if(e.target.value==='temporary')setHuman(true);}} className={inputClass}><option value="long_term">{en?'Long-term knowledge':'长期知识文档'}</option><option value="temporary">{en?'Temporary document':'临时文档'}</option></select></label>
  <label>{en?'Starts (Beijing time)':'生效时间（北京时间）'}<input type="datetime-local" required value={from} onChange={e=>setFrom(e.target.value)} className={inputClass}/></label><label>{en?'Ends (Beijing time, exclusive)':'结束时间（该时刻起失效，北京时间）'}<input type="datetime-local" required value={until} onChange={e=>setUntil(e.target.value)} className={inputClass}/></label>
  <fieldset className="md:col-span-2"><legend>{en?'Channels (none = all)':'适用渠道（不勾选表示全部）'}</legend><div className="mt-2 flex flex-wrap gap-4">{[['web_chat','网站聊天','Web Chat'],['shared_wechat','共享公众号','Shared WeChat'],['wechat_official_account','独立公众号','WeChat Official Account']].map(([v,zh,eng])=><label key={v}><input type="checkbox" className="mr-2" checked={channels.includes(v)} onChange={e=>setChannels(e.target.checked?[...channels,v]:channels.filter(x=>x!==v))}/>{en?eng:zh}</label>)}</div></fieldset>
  {from&&until&&!validPeriod&&<p role="alert" className="md:col-span-2 text-sm text-amber-800">{en?'The end must be later than the start and current time (up to year 2200).':'结束时间须晚于生效时间和当前时间，最晚至 2200 年。'}</p>}
  <div className="md:col-span-2"><p id={fileLabel} className="text-sm text-[var(--ink-500)]">{en?'TXT, Markdown, PDF or DOCX; up to 10 MiB':'TXT、Markdown、PDF、DOCX，不超过 10 MiB'}</p>
   <input ref={fileInput} name="file" type="file" required accept=".txt,.md,.pdf,.docx" aria-label={en?'Knowledge document file':'知识文档文件'} aria-describedby={fileLabel} className="sr-only" tabIndex={-1} onChange={event=>{const file=event.currentTarget.files?.[0]??null;setSelectedFile(file);setFileError(file&&(!/\.(txt|md|pdf|docx)$/i.test(file.name)||file.size>10*1024*1024||file.size===0)?en?'Choose a supported, non-empty file no larger than 10 MiB.':'请选择支持的非空文件，且不超过 10 MiB。':'');}}/>
   <div className="mt-2 flex min-w-0 flex-wrap items-center gap-3"><button type="button" disabled={submitting} onClick={()=>fileInput.current?.click()} aria-describedby={fileLabel} className="inline-flex w-fit shrink-0 items-center gap-2 rounded-xl border border-[var(--brand-200)] bg-blue-50 px-4 py-2.5 text-sm font-semibold text-[var(--brand-700)] hover:bg-blue-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-500)] disabled:opacity-40"><Upload size={16}/>{selectedFile?(en?'Change file':'更换文件'):(en?'Choose file':'选择文件')}</button>
   <span aria-live="polite" className="min-w-0 break-all text-sm text-[var(--ink-500)]">{selectedFile?selectedFile.name+(en?' · ':' · ')+Math.ceil(selectedFile.size/1024)+' KiB':en?'No file selected':'未选择文件'}</span></div>
   {fileError&&<p role="alert" className="mt-2 text-sm text-red-700">{fileError}</p>}
  </div>
  <label className="md:col-span-2 text-sm"><input type="checkbox" className="mr-2" checked={human} onChange={e=>setHuman(e.target.checked)}/>{en?'Requires human confirmation, excluded from automatic replies.':'需要人工确认，不用于自动回复。'}</label>
  <label className="md:col-span-2 text-sm"><input type="checkbox" className="mr-2" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>{en?'I verified the file, validity and scope. Publish after safe processing; indexing may consume AI points.':'我已核对文件、有效期与范围；安全处理后发布，索引可能消耗 AI 点数。'}</label>
  <input type="hidden" name="source_type" value={kind==='temporary'?'temporary_policy_text':'knowledge'}/><input type="hidden" name="document_settings" value={JSON.stringify({document_kind:kind,valid_from:iso(from),valid_until:iso(until),scope:channels.length?{channels}:{},requires_human_approval:human})}/>
  <button disabled={submitting||!confirmed||!validPeriod||!selectedFile||!!fileError} className="w-fit rounded-xl bg-[var(--brand-500)] px-5 py-3 text-sm font-semibold text-white disabled:opacity-40">{submitting?(en?'Uploading…':'正在上传…'):en?'Upload and publish after processing':'上传并在处理完成后发布'}</button>
 </form>;
}
