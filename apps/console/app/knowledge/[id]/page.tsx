import { ConsolePageHeading } from "../../../components/console-page-heading";
import { ArrowLeft, Download, FileText } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { ConsoleShell } from "../../../components/console-shell";
import { fetchConsoleSession, gatewayUrl, sessionToken } from "../../../lib/console-session";
import { getConsoleLocale } from "../../../lib/console-locale-server";

export const dynamic = "force-dynamic";

type PreviewDocument = {
  document_id:string; title:string; source_type:string; version:number; status:string;
  content_format:string; original_filename:string|null; file_size:string|number|null;
  ingestion_status:string; scan_status:string; parse_status:string; updated_at:string;
  preview_text:string; preview_characters:number; preview_truncated:boolean; download_available:boolean;
};

const labels:Record<string,string>={knowledge:"企业知识",faq:"常见问题",script:"话术参考",temporary_policy_text:"临时规则材料"};

export default async function KnowledgeDocumentPage({params}:{params:Promise<{id:string}>}){
  const locale=await getConsoleLocale();const en=locale==="en";const labelsEn:Record<string,string>={knowledge:"Business knowledge",faq:"FAQ",script:"Reply wording",temporary_policy_text:"Temporary policy material"};
  const session=await fetchConsoleSession();const token=await sessionToken();
  if(!session||!token)redirect("/login?error=expired");
  const workspace=session.workspaces.find(item=>item.tenant_id===session.selected_tenant_id);if(!workspace)redirect("/workspaces");
  const {id}=await params;if(!/^[0-9a-f-]{36}$/i.test(id))notFound();
  const upstream=await fetch(gatewayUrl(`/api/v1/ai/knowledge/documents/${id}`),{headers:{authorization:`Bearer ${token}`},cache:"no-store"});
  if(upstream.status===401)redirect("/login?error=expired");
  if(upstream.status===404)notFound();
  if(!upstream.ok)throw new Error("Knowledge preview is unavailable");
  const body=await upstream.json() as {data:PreviewDocument};const document=body.data;
  return <ConsoleShell session={session} workspace={workspace} activePath="/knowledge" statusPageUrl={process.env.STATUS_PUBLIC_URL??"http://localhost:3300"}><main className="mx-auto min-h-screen max-w-6xl p-4 md:p-8">
    <a href="/knowledge" className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--brand-700)]"><ArrowLeft size={16}/>{en?"Back to knowledge base":"返回知识库"}</a>
    <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><ConsolePageHeading icon="document">{document.title}</ConsolePageHeading><p className="mt-2 text-sm text-[var(--ink-500)]">{document.original_filename??(en?"Console text entry":"控制台文本录入")} · {Math.ceil(Number(document.file_size??0)/1024)} KiB · {en?"Updated":"更新于"} {new Date(document.updated_at).toLocaleString(en?"en":"zh-CN",{timeZone:"Asia/Shanghai"})}</p></div>{document.download_available?<a href={`/api/knowledge/documents/${document.document_id}/download`} className="inline-flex self-start items-center gap-2 rounded-xl bg-[var(--brand-500)] px-4 py-2.5 text-sm font-semibold text-white"><Download size={16}/>{en?"Download original":"下载原始内容"}</a>:null}</div>
    <section className="mt-6 overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-white shadow-[var(--shadow-card)]"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-4"><h2 className="flex items-center gap-2 font-semibold"><FileText size={18}/>{en?"Safe text preview":"安全文本预览"}</h2><span className="text-xs text-[var(--ink-500)]">{en?"Security scan":"安全扫描"}：{document.scan_status} · {en?"Parse":"解析"}：{document.parse_status}</span></div>{document.preview_truncated?<p className="border-b border-amber-200 bg-amber-50 px-5 py-3 text-xs text-amber-800">{en?"This document is long. The page shows the first 200,000 characters; download the original for the complete content.":"文档较长，页面仅显示前 200,000 个字符；下载可获取完整原始内容。"}</p>:null}<pre className="max-h-[68vh] overflow-auto whitespace-pre-wrap break-words p-5 font-sans text-sm leading-7 text-[var(--ink-700)]">{document.preview_text||(en?"This document has no displayable text.":"文档没有可显示的文本内容。")}</pre></section>
  </main></ConsoleShell>;
}
