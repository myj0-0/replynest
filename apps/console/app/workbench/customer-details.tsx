"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { UserRound, X, Pencil, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { BodyPortal } from "../../components/body-portal";

const DetailsContext = createContext({ open: false, setOpen: (_value: boolean) => {} });
export function CustomerDetailsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <DetailsContext.Provider value={{ open, setOpen }}>{children}</DetailsContext.Provider>;
}
export function CustomerDetailsButton({ en }: { en: boolean }) {
  const { open, setOpen } = useContext(DetailsContext);
  return <button type="button" onClick={() => setOpen(true)} aria-expanded={open} aria-haspopup="dialog" title={en ? "Customer details" : "客户资料"} className="grid size-9 shrink-0 place-items-center rounded-lg border border-[var(--border-subtle)] bg-white text-slate-600 xl:hidden"><UserRound size={18}/><span className="sr-only">{en ? "Customer details" : "客户资料"}</span></button>;
}
function Drawer({ children, en, close }: { children: ReactNode; en: boolean; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    const media = window.matchMedia("(min-width: 1280px)");
    const changed = () => { if (media.matches) close(); };
    media.addEventListener("change", changed);
    return () => { media.removeEventListener("change", changed); previous?.focus(); };
  }, [close]);
  return <dialog ref={ref} onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }} aria-labelledby="customer-details-title" className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none bg-transparent p-0 backdrop:bg-slate-900/30 open:flex open:justify-end">
    <section className="flex h-full w-full max-w-sm flex-col border-l border-slate-200 bg-white shadow-xl">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-3"><h2 id="customer-details-title" className="font-semibold">{en ? "Customer details" : "客户资料"}</h2><button autoFocus type="button" onClick={close} className="grid size-9 place-items-center rounded-lg hover:bg-slate-100" aria-label={en ? "Close customer details" : "关闭客户资料"}><X size={18}/></button></header>
      <div className="studio-details-content min-h-0 flex-1 overflow-y-auto overscroll-contain break-words p-5 pb-[max(20px,env(safe-area-inset-bottom))]">{children}</div>
    </section>
  </dialog>;
}
export function CustomerDetailsPanel({ children, en }: { children: ReactNode; en: boolean }) {
  const { open, setOpen } = useContext(DetailsContext);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const update = () => { setWide(media.matches); if (media.matches) setOpen(false); };
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [setOpen]);
  const close = useCallback(() => setOpen(false), [setOpen]);
  return <><aside className="hidden min-h-0 min-w-0 overflow-y-auto break-words border-l border-[var(--border-subtle)] bg-white p-5 xl:block" aria-label={en ? "Customer details" : "客户资料"}>{wide && <div className="studio-details-content">{children}</div>}</aside>{open && !wide && <BodyPortal><Drawer en={en} close={close}>{children}</Drawer></BodyPortal>}</>;
}

type Profile = { name: string; display_name?: string; email: string; phone: string; note: string; revision: string; can_edit: boolean; wechat?:{nickname:string;avatar_url:string} };
export function CustomerProfileEditor({ conversationId, en }: { conversationId: string; en: boolean }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [draft, setDraft] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const router = useRouter();
  const url = `/api/conversations/${conversationId}/customer-profile`;
  async function load(signal?: AbortSignal) {
    setError("");
    try { const response = await fetch(url, { cache: "no-store", signal }); if (!response.ok) throw new Error(); const body = await response.json(); setProfile(body.data); }
    catch { if (!signal?.aborted) setError(en ? "Unable to load customer details." : "暂时无法读取客户资料。"); }
  }
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [url]);
  async function save() {
    if (!draft || busy) return;
    setBusy(true); setError(""); setSaved(false);
    try {
      // Display-only suffix/nickname is never implicitly saved as a staff rename.
      const input = {name:draft.name,email:draft.email,phone:draft.phone,note:draft.note,revision:draft.revision};
      const response = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) {
        setError(response.status === 409 ? (en ? "Details changed elsewhere. Cancel and reload before editing again; your draft is kept." : "资料已被其他人更新。请取消并重新载入后再编辑，当前草稿已保留。") : response.status === 403 ? (en ? "Only a manager or the assigned agent can edit." : "仅管理员、主管或当前负责坐席可编辑。") : (en ? "Save was not confirmed. Reload to check before retrying." : "未确认保存成功，请重新载入核实后再试。"));
        return;
      }
      const body = await response.json(); setProfile(body.data); setDraft(null); setSaved(true); router.refresh();
    } catch { setError(en ? "Connection failed. Your draft is kept." : "连接失败，草稿已保留。"); } finally { setBusy(false); }
  }
  return <section className="space-y-3 border-b border-slate-200 pb-5">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{en ? "Customer profile" : "客户资料与备注"}</h3>{profile?.can_edit && !draft && <button type="button" onClick={() => { setDraft({ ...profile }); setSaved(false); }} className="inline-flex items-center gap-1 text-xs text-blue-700"><Pencil size={13}/>{en ? "Edit" : "编辑"}</button>}</div>
    {!profile && !error && <p className="text-xs text-slate-500">{en ? "Loading…" : "正在读取…"}</p>}
    {draft ? <form onSubmit={event => { event.preventDefault(); void save(); }} className="space-y-3">
      {(["name", "email", "phone", "note"] as const).map(field => <label key={field} className="block text-xs text-slate-600">{{ name: en ? "Display name" : "客户名称", email: en ? "Email" : "邮箱", phone: en ? "Phone" : "电话", note: en ? "Internal customer note" : "客户内部备注" }[field]}{field === "note" ? <textarea rows={5} maxLength={5000} disabled={busy} value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })} className="mt-1 w-full resize-y rounded-lg border border-slate-200 p-2 text-sm"/> : <input type={field === "email" ? "email" : field === "phone" ? "tel" : "text"} required={field === "name"} maxLength={field === "name" ? 200 : field === "phone" ? 64 : 320} disabled={busy} value={draft[field]} onChange={event => setDraft({ ...draft, [field]: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-200 p-2 text-sm"/>}</label>)}
      <p className="text-[11px] leading-5 text-slate-500">{en ? "Saved for your team only. Not sent to the customer." : "仅供企业内部使用，不会发给客户。"}</p>
      <div className="flex gap-2"><button disabled={busy} className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"><Save size={13}/>{busy ? (en ? "Saving…" : "保存中…") : (en ? "Save" : "保存")}</button><button type="button" disabled={busy} onClick={() => { setDraft(null); void load(); }} className="rounded-lg border border-slate-200 px-3 py-2 text-xs">{en ? "Cancel / reload" : "取消并重新载入"}</button></div>
    </form> : profile && <dl className="space-y-3 text-sm">{(["name", "email", "phone", "note"] as const).map(field => <div key={field}><dt className="text-xs text-slate-500">{{ name: en ? "Display name" : "客户名称", email: en ? "Email" : "邮箱", phone: en ? "Phone" : "电话", note: en ? "Internal note · team only" : "内部备注 · 仅团队可见" }[field]}</dt><dd className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{(field==='name'?profile.display_name??profile.name:profile[field]) || (en ? "Not provided" : "未填写")}</dd></div>)}{!profile.can_edit && <p className="text-xs text-slate-500">{en ? "A manager or the assigned agent can edit." : "管理员、主管或当前负责坐席可编辑。"}</p>}</dl>}
    {profile?.wechat && <div className="flex items-center gap-2 rounded-lg bg-slate-50 p-2">{profile.wechat.avatar_url && <img src={profile.wechat.avatar_url} referrerPolicy="no-referrer" alt="" className="size-10 rounded-full"/>}<div><p className="text-sm">{profile.wechat.nickname}</p><p className="text-xs text-slate-500">{en?'Authorized WeChat profile':'微信授权昵称与头像'}</p></div></div>}
    {saved && <p role="status" className="text-xs text-green-700">{en ? "Saved" : "已保存"}</p>}
    {error && <div role="alert" className="text-xs text-red-700">{error}{!draft && <button type="button" onClick={() => void load()} className="ml-2 underline">{en ? "Reload" : "重新载入"}</button>}</div>}
  </section>;
}
