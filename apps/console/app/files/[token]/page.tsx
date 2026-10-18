import { Download, FileText, ShieldCheck } from "lucide-react";
import { headers } from "next/headers";
import { BrandLogo } from "../../../components/brand-logo";
import { gatewayUrl } from "../../../lib/console-session";

export const dynamic = "force-dynamic";
type Transfer = { file_name: string | null; size_bytes: number | null; expires_at: string; download_available: boolean; download_count: number; max_downloads: number };

function size(value: number | null, en: boolean) { if (value === null) return "—"; return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`; }

export default async function FileDownloadPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params; const language = (await headers()).get("accept-language") ?? ""; const en = !language.toLowerCase().startsWith("zh");
  let transfer: Transfer | undefined;
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) try { const response = await fetch(gatewayUrl(`/api/v1/public/file-transfers/${token}`), { cache: "no-store" }); if (response.ok) transfer = (await response.json() as { data?: Transfer }).data; } catch { /* Render unavailable state. */ }
  return <main className="min-h-screen bg-slate-100 px-4 py-10 text-[var(--ink-900)]"><section className="mx-auto max-w-lg rounded-3xl border border-[var(--border-subtle)] bg-white p-7 shadow-[var(--shadow-card)] sm:p-9"><BrandLogo href="https://replynest.cn" priority/><div className="mt-8 grid size-12 place-items-center rounded-2xl bg-blue-50 text-[var(--brand-700)]"><FileText size={22}/></div><h1 className="mt-5 text-2xl font-semibold">{en ? "Secure file delivery" : "安全文件下载"}</h1>{transfer ? <><p className="mt-3 break-all text-sm font-semibold">{transfer.file_name ?? (en ? "Shared file" : "共享文件")}</p><p className="mt-2 text-xs leading-5 text-[var(--ink-500)]">{size(transfer.size_bytes, en)} · {en ? "Expires" : "有效期至"} {new Date(transfer.expires_at).toLocaleString(en ? "en-US" : "zh-CN")}</p>{transfer.download_available ? <a href={`/api/public/file-transfers/${token}/content`} className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--brand-500)] px-4 py-3 text-sm font-semibold text-white"><Download size={17}/>{en ? "Download file" : "下载文件"}</a> : <p className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{en ? "This link has expired or reached its download limit." : "此链接已过期或已达到下载次数限制。"}</p>}</> : <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{en ? "This file link is unavailable or expired." : "文件链接不可用或已经过期。"}</p>}<div className="mt-7 flex items-start gap-2 border-t pt-5 text-xs leading-5 text-[var(--ink-500)]"><ShieldCheck className="mt-0.5 shrink-0" size={15}/><span>{en ? "Files are malware-scanned and delivered through an expiring ReplyNest link. Do not forward this link." : "文件经安全扫描并通过限时答巢链接交付，请勿转发此链接。"}</span></div></section></main>;
}
