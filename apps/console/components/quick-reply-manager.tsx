"use client";

import { useEffect, useRef, useState } from "react";
import { Download, FileUp, Pencil, Trash2, Zap } from "lucide-react";

type ImageAsset={asset_id:string;file_name:string;preview_url:string;size_bytes:number};
type Reply = { quick_reply_id: string; shortcut: string; title: string; content: string;image?:ImageAsset|null;reply_type?:string };
const empty = { shortcut: "", title: "", content: "",image_asset_id:null as string|null };
const field = "w-full rounded-xl border border-[var(--border-subtle)] bg-white px-3 py-2.5 text-sm";
const button = "inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-white px-3 py-2 text-sm disabled:opacity-50";

export function QuickReplyManager({ en }: { en: boolean }) {
  const [items, setItems] = useState<Reply[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState(empty);
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const [imagesEnabled,setImagesEnabled]=useState(false),[image,setImage]=useState<ImageAsset|null>(null),[uploading,setUploading]=useState(false);
  const imageInput=useRef<HTMLInputElement>(null),imageFlight=useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError(""); setItems([]); setNext(null); setCanManage(false);setImagesEnabled(false);
    fetch(`/api/quick-replies?mode=manage&query=${encodeURIComponent(search)}&offset=${offset}`, { cache: "no-store", signal: abort.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message ?? (en ? "Could not load quick replies." : "快捷回复加载失败，请重试。"));
        if (!abort.signal.aborted) { setItems(body.data ?? []); setNext(body.next_offset ?? null); setCanManage(body.can_manage === true);setImagesEnabled(body.images_enabled===true); }
      }).catch(err => { if (!abort.signal.aborted) setError(err.message); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [search, offset, revision, en]);

  async function mutate(url: string, options: RequestInit, message: string) {
    if (!canManage || inFlight.current||imageFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(url, options); const body = await response.json();
      if (!response.ok) { if (response.status === 403) setCanManage(false); throw new Error(body.error?.message ?? (en ? "Operation failed." : "操作失败。")); }
      setNotice(body.data?.total != null ? (en ? `Imported ${body.data.total}: ${body.data.created} created, ${body.data.updated} updated.` : `已导入 ${body.data.total} 条：新增 ${body.data.created} 条，更新 ${body.data.updated} 条。`) : message);
      setDraft(empty);setImage(null); setEditing(null); setOffset(0); setRevision(v => v + 1);
    } catch (err) { setError(err instanceof Error ? err.message : (en ? "Check the result before retrying." : "请核查结果后再重试。")); }
    finally { inFlight.current = false; setBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  async function uploadImage(file?:File){
    if(!file||!canManage||!imagesEnabled||busy||imageFlight.current)return;
    if(!file.size||file.size>2*1024*1024||!['image/jpeg','image/png','image/gif'].includes(file.type)){setError(en?'Choose a JPEG, PNG or GIF image up to 2 MiB.':'请选择不超过 2 MiB 的 JPEG、PNG 或 GIF 图片。');return;}
    imageFlight.current=true;setUploading(true);setError('');setNotice('');
    try{const form=new FormData();form.set('file',file);const r=await fetch('/api/quick-reply-images',{method:'POST',body:form});const body=await r.json();if(!r.ok||!body.data)throw Error(body.error?.message??(en?'Image upload failed.':'图片上传失败。'));setImage(body.data);setDraft(d=>({...d,image_asset_id:body.data.asset_id}));setNotice(en?'Image scanned. Save to attach it to this quick reply; no customer message was sent.':'图片已通过安全处理。保存后成为快捷回复素材，上传本身不会发给客户。');}
    catch(error){setError(error instanceof Error?error.message:'图片处理失败。');}finally{imageFlight.current=false;setUploading(false);if(imageInput.current)imageInput.current.value='';}
  }

  return <section id="quick-replies" aria-labelledby="quick-replies-title" data-layout-mutation-busy={busy||uploading?'true':undefined} className="mt-6 scroll-mt-6 rounded-2xl border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)] md:p-6">
    <h2 id="quick-replies-title" className="flex items-center gap-2 font-semibold"><Zap size={19}/>{en ? "Quick replies" : "快捷回复"}</h2>
    <p className="mt-2 text-sm leading-6 text-[var(--ink-500)]">{en ? "Shared across this workspace. Administrators and supervisors can manage; agents can search and use replies in the workbench. Quick replies are not automatically added to AI knowledge." : "企业内共享。管理员和主管可管理，普通坐席仅可在工作台搜索和使用；快捷回复不会自动作为 AI 知识入库。"}</p>
    {error && <div role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}<button type="button" className="ml-3 underline" onClick={() => setRevision(v => v + 1)}>{en ? "Reload list" : "重新加载列表"}</button></div>}
    {notice && <p role="status" className="mt-3 rounded-xl bg-green-50 p-3 text-sm text-green-700">{notice}</p>}
    {canManage && <div className="mt-5 space-y-4">
      <details open={!!editing||!!error||busy||uploading} className="rounded-xl border border-[var(--border-subtle)] p-4"><summary className="cursor-pointer text-sm font-semibold text-blue-700">{editing?(en?'Edit selected quick reply':'编辑所选快捷回复'):(en?'Add quick reply':'新增快捷回复')}</summary><div className="mt-4">
      <form onSubmit={event => { event.preventDefault(); void mutate(editing ? `/api/quick-replies/${editing}` : "/api/quick-replies", { method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) }, en ? "Quick reply saved." : "快捷回复已保存。"); }}>
        <fieldset disabled={busy||uploading} className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-3 font-medium">{editing ? (en ? "Edit quick reply" : "编辑快捷回复") : (en ? "Add quick reply" : "新增快捷回复")}</legend>
          <label className="text-sm">{en ? "Shortcut" : "快捷指令"}<input required pattern="[a-z0-9_-]{1,32}" maxLength={32} value={draft.shortcut} onChange={e => setDraft({ ...draft, shortcut: e.target.value })} placeholder="shipping" className={field}/></label>
          <label className="text-sm">{en ? "Title" : "标题"}<input required maxLength={80} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} className={field}/></label>
          <label className="text-sm sm:col-span-2">{en ? "Reply text" : "回复文字"}<textarea required={!draft.image_asset_id} maxLength={4000} rows={3} value={draft.content} onChange={e => setDraft({ ...draft, content: e.target.value })} className={field}/></label>
          {imagesEnabled&&<div className="space-y-3 sm:col-span-2"><input ref={imageInput} type="file" accept="image/jpeg,image/png,image/gif" className="hidden" onChange={event=>void uploadImage(event.target.files?.[0])}/><button type="button" className={button} onClick={()=>imageInput.current?.click()}>{uploading?(en?'Scanning…':'安全处理中…'):image?(en?'Replace image':'更换图片'):(en?'Add image':'添加图片')}</button><p className="text-xs leading-5 text-[var(--ink-500)]">{en?'One JPEG, PNG or GIF up to 2 MiB. Image only, or image followed by text. Each part uses one WeChat reply; sending still requires agent confirmation.':'每条可保存 1 张 JPEG、PNG 或 GIF 图片，最多 2 MiB。可仅图片，也可图片后接文字；每部分各占一条微信回复，仍由客服预览并确认发送。'}</p>{image&&<div className="flex items-start gap-3 rounded-xl border p-3"><img src={`/api/quick-reply-images/${encodeURIComponent(image.asset_id)}/content`} alt={en?'Quick reply image preview':'快捷回复图片预览'} className="size-24 shrink-0 rounded-lg object-contain" referrerPolicy="no-referrer"/><div className="min-w-0 flex-1"><p className="break-all text-sm">{image.file_name}</p><button type="button" className={button} onClick={()=>{setImage(null);setDraft(d=>({...d,image_asset_id:null}));}}>{en?'Remove image':'移除图片'}</button></div></div>}</div>}
          {imagesEnabled&&<p className="text-xs leading-5 text-[var(--ink-500)] sm:col-span-2">{en?'Up to 200 images / 20 MiB per workspace. Saved images remain available; unattached uploads are cleaned up after 7 days.':'每企业最多 200 张、总计 20 MiB；已保存素材长期可用，未绑定上传在 7 天后清理。'}</p>}
          <div className="flex gap-2 sm:col-span-2"><button disabled={!draft.content.trim()&&!draft.image_asset_id} className="rounded-xl bg-[var(--brand-500)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? (en ? "Saving…" : "保存中…") : (en ? "Save quick reply" : "保存快捷回复")}</button>{editing && <button type="button" className={button} onClick={() => { setEditing(null); setDraft(empty);setImage(null); }}>{en ? "Cancel edit" : "取消编辑"}</button>}</div>
        </fieldset>
      </form>
      </div></details>
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed p-3">
        <input ref={fileInput} type="file" accept=".xlsx,.md" className="hidden" onChange={event => {
          const file = event.target.files?.[0]; if (!file) return;
          if (!window.confirm(en ? "Import updates existing shortcuts and creates new ones. Continue?" : "导入会覆盖同名快捷指令的标题和内容，并新增其他指令。确定继续？")) { event.target.value = ""; return; }
          const form = new FormData(); form.set("file", file); void mutate("/api/quick-replies/import", { method: "POST", body: form }, "");
        }}/>
        <button type="button" disabled={busy||uploading} onClick={() => fileInput.current?.click()} className={button}><FileUp size={16}/>{en ? "Import Excel / Markdown" : "导入 Excel / Markdown"}</button>
        <a href="/templates/replynest-quick-replies-template.xlsx" download className={button}><Download size={16}/>{en ? "Excel template" : "Excel 模板"}</a>
        <a href="/templates/replynest-quick-replies-template.md" download className={button}><Download size={16}/>{en ? "Markdown template" : "Markdown 模板"}</a>
        <p className="basis-full text-xs text-[var(--ink-500)]">{en ? "Text imports only: up to 500 rows and 2 MiB. Image/image-and-text shortcuts cannot be overwritten by a text import." : "导入仅支持文字：单次最多 500 条，文件不超过 2 MiB；同名图片或图文快捷回复不能用文字导入覆盖，请在管理页面编辑。"}</p>
      </div>
    </div>}
    <form className="mt-5 flex gap-2" onSubmit={e => { e.preventDefault(); setSearch(query); setOffset(0); }}><input aria-label={en ? "Search quick replies" : "搜索快捷回复"} placeholder={en ? "Shortcut, title or content" : "搜索指令、标题或内容"} maxLength={80} value={query} onChange={e => setQuery(e.target.value)} className={field}/><button className={button} disabled={busy||uploading}>{en ? "Search" : "搜索"}</button></form>
    <div aria-busy={loading} className="mt-4 divide-y">
      {loading ? <p className="py-4 text-sm">{en ? "Loading…" : "加载中…"}</p> : items.length === 0 && !error ? <p className="py-4 text-sm text-[var(--ink-500)]">{en ? "No matching quick replies." : "暂无匹配的快捷回复。"}</p> : items.map(item => <article key={item.quick_reply_id} className="py-4">
        <div className="flex items-start justify-between gap-3"><p className="min-w-0 break-words text-sm font-semibold"><span className="text-[var(--brand-700)]">/{item.shortcut}</span> · {item.title}</p>{canManage && <div className="flex shrink-0 gap-2"><button type="button" disabled={busy||uploading} aria-label={`${en ? "Edit" : "编辑"} /${item.shortcut}`} className={button} onClick={() => { setEditing(item.quick_reply_id); setDraft({shortcut:item.shortcut,title:item.title,content:item.content,image_asset_id:item.image?.asset_id??null});setImage(item.image??null); }}><Pencil size={14}/>{en ? "Edit" : "编辑"}</button><button type="button" disabled={busy||uploading} aria-label={`${en ? "Delete" : "删除"} /${item.shortcut}`} className={button} onClick={() => { if (window.confirm(en ? `Delete /${item.shortcut}?` : `删除快捷回复 /${item.shortcut}？`)) void mutate(`/api/quick-replies/${item.quick_reply_id}`, { method: "DELETE" }, en ? "Deleted." : "已删除。"); }}><Trash2 size={14}/></button></div>}</div>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--ink-700)]">{item.content}</p>{item.image&&<img src={`/api/quick-reply-images/${encodeURIComponent(item.image.asset_id)}/content`} alt={en?'Quick reply image':'快捷回复图片'} loading="lazy" referrerPolicy="no-referrer" className="mt-3 size-24 rounded-xl border object-contain"/>}
      </article>)}
    </div>
    <div className="mt-3 flex items-center gap-3"><button type="button" disabled={offset === 0 || loading || busy} className={button} onClick={() => setOffset(Math.max(0, offset - 50))}>{en ? "Previous" : "上一页"}</button><span className="text-xs">{en ? `Page ${offset / 50 + 1}` : `第 ${offset / 50 + 1} 页`}</span><button type="button" disabled={next === null || loading || busy} className={button} onClick={() => { if(next !== null) setOffset(next); }}>{en ? "Next" : "下一页"}</button></div>
  </section>;
}
