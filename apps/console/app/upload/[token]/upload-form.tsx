"use client";

import { CheckCircle2, LoaderCircle, UploadCloud } from "lucide-react";
import { useState } from "react";

export function UploadForm({ token, en }: { token: string; en: boolean }) {
  const [busy, setBusy] = useState(false); const [done, setDone] = useState(false); const [error, setError] = useState("");
  async function upload(file?: File) {
    if (!file || busy) return; setBusy(true); setError("");
    try { const form = new FormData(); form.set("file", file); const response = await fetch(`/api/public/file-transfers/${token}`, { method: "POST", body: form }); const body = await response.json() as { error?: { message?: string } }; if (!response.ok) { setError(body.error?.message ?? (en ? "Upload failed." : "上传失败。")); return; } setDone(true); }
    catch { setError(en ? "Upload failed. Please retry." : "上传失败，请重试。"); } finally { setBusy(false); }
  }
  if (done) return <div className="mt-6 rounded-2xl border border-green-200 bg-green-50 p-5 text-green-800"><CheckCircle2 size={22}/><p className="mt-2 font-semibold">{en ? "File uploaded" : "文件已上传"}</p><p className="mt-1 text-sm">{en ? "The support agent can now access it. This upload link cannot be reused." : "客服人员现在可以查看此文件；此上传链接不能再次使用。"}</p></div>;
  return <div className="mt-6"><label className="flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed border-blue-200 bg-blue-50/50 px-5 py-8 text-center hover:bg-blue-50"><span className="grid size-11 place-items-center rounded-xl bg-white text-[var(--brand-700)]">{busy ? <LoaderCircle className="animate-spin" size={21}/> : <UploadCloud size={21}/>}</span><span className="mt-3 text-sm font-semibold">{busy ? (en ? "Scanning and uploading…" : "正在扫描并上传…") : (en ? "Choose a file" : "选择文件")}</span><span className="mt-1 text-xs leading-5 text-[var(--ink-500)]">{en ? "Images, PDF, text, Markdown, CSV, DOCX or XLSX · up to 25 MiB" : "图片、PDF、文本、Markdown、CSV、DOCX 或 XLSX · 不超过 25 MiB"}</span><input type="file" disabled={busy} accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.txt,.md,.csv,.docx,.xlsx" className="hidden" onChange={event => void upload(event.target.files?.[0])}/></label>{error && <p className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}</div>;
}
