import { ShieldCheck } from "lucide-react";
import { headers } from "next/headers";
import { BrandLogo } from "../../../components/brand-logo";
import { gatewayUrl } from "../../../lib/console-session";
import { UploadForm } from "./upload-form";

export const dynamic = "force-dynamic";
type Transfer = { upload_available: boolean; expires_at: string };

export default async function UploadPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params; const language = (await headers()).get("accept-language") ?? ""; const en = !language.toLowerCase().startsWith("zh");
  let transfer: Transfer | undefined;
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) try { const response = await fetch(gatewayUrl(`/api/v1/public/file-transfers/${token}`), { cache: "no-store" }); if (response.ok) transfer = (await response.json() as { data?: Transfer }).data; } catch { /* Render unavailable state. */ }
  return <main className="min-h-screen bg-slate-100 px-4 py-10 text-[var(--ink-900)]"><section className="mx-auto max-w-lg rounded-3xl border border-[var(--border-subtle)] bg-white p-7 shadow-[var(--shadow-card)] sm:p-9"><BrandLogo href="https://replynest.cn" priority/><h1 className="mt-8 text-2xl font-semibold">{en ? "Upload a file to support" : "向客服上传文件"}</h1><p className="mt-2 text-sm leading-6 text-[var(--ink-500)]">{en ? "Use this private, single-use link to send a file to the support agent who invited you." : "请使用这个私密的一次性链接，把文件发送给邀请您的客服人员。"}</p>{transfer?.upload_available ? <><UploadForm token={token} en={en}/><p className="mt-3 text-xs text-[var(--ink-500)]">{en ? "Link expires" : "链接有效期至"} {new Date(transfer.expires_at).toLocaleString(en ? "en-US" : "zh-CN")}</p></> : <p className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{en ? "This upload link is unavailable, expired, or already used." : "上传链接不可用、已经过期或已被使用。"}</p>}<div className="mt-7 flex items-start gap-2 border-t pt-5 text-xs leading-5 text-[var(--ink-500)]"><ShieldCheck className="mt-0.5 shrink-0" size={15}/><span>{en ? "The file is malware-scanned before it becomes available to the support agent." : "文件通过安全扫描后才会提供给客服人员。"}</span></div></section></main>;
}
