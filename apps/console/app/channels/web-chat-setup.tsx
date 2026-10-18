"use client";
import { useEffect, useState } from "react";
type Site = { connection_id: string; display_name: string; status: string; website_url: string };
export function WebChatSetup({ en, admin }: { en: boolean; admin: boolean }) {
  const [site, setSite] = useState<Site | null>(null), [origin, setOrigin] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [copied, setCopied] = useState(false);
  useEffect(() => {
    setOrigin(window.location.origin);
    if (!admin) { setLoading(false); return; }
    fetch("/api/channels/web-chat", { cache: "no-store" }).then(async response => { if (!response.ok) throw new Error(); const body = await response.json(); setSite(body.data); }).catch(() => setError(en ? "Could not load website settings. Refresh to retry." : "读取网站配置失败，请刷新重试。")).finally(() => setLoading(false));
  }, [admin, en]);
  const code = site?.status === "ready" ? `<script src="${origin}/widget/${site.connection_id}" async></script>` : "";
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const data = new FormData(event.currentTarget); setBusy(true); setError("");
    try {
      const response = await fetch("/api/channels/web-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ display_name: data.get("display_name"), website_url: data.get("website_url") }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.code === "entitlement_limit_reached" ? (en ? "Your plan’s channel limit has been reached." : "已达到套餐渠道数量上限。") : (en ? "Setup could not be confirmed. Refresh before retrying; retries reuse the same inbox." : "未确认配置成功。请先刷新核实，再重试；重试会复用同一收件箱。"));
      setSite(body.data);
    } catch(error) { setError(error instanceof Error ? error.message : "Setup failed"); } finally { setBusy(false); }
  }
  return <section className="mt-6 rounded-2xl border border-[var(--border-subtle)] bg-white p-5 shadow-sm" id="website-chat"><h2 className="font-semibold">{en ? "Website chat" : "网站聊天 Web Chat"}</h2><p className="mt-2 text-sm text-slate-500">{en ? "Add a chat bubble to your website. Agents answer visitors in the ReplyNest support workspace." : "在网站插入聊天气泡，访客直接咨询，客服在答巢工作台统一回复。"}</p>
    {!admin ? <p className="mt-3 text-sm">{en ? "Ask your workspace admin to configure the website channel." : "请由企业管理员配置网站渠道。"}</p> : loading ? <p className="mt-3 text-sm">{en ? "Loading…" : "正在读取…"}</p> : site?.status === "ready" ? <div className="mt-4 space-y-3"><p className="text-sm text-green-700">{site.display_name} · {en ? "Configured" : "已配置"} · {site.website_url}</p><p className="text-sm">{en ? "Paste this before the closing </body> tag on your website:" : "把以下代码粘贴到网站 </body> 结束标签之前："}</p><textarea readOnly aria-label={en ? "Embed code" : "网站嵌入代码"} value={code} rows={3} className="w-full rounded-lg border bg-slate-50 p-3 font-mono text-xs"/><div className="flex flex-wrap gap-3"><button type="button" onClick={async () => { try { await navigator.clipboard.writeText(code); setCopied(true); } catch { setError(en ? "Select and copy the code manually." : "请选中代码手动复制。"); } }} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white">{copied ? (en ? "Copied" : "已复制") : (en ? "Copy code" : "复制代码")}</button><a href={`/web-chat/preview?site=${site.connection_id}`} target="_blank" rel="noopener noreferrer" className="rounded-lg border px-4 py-2 text-sm">{en ? "Open visitor preview" : "打开访客测试页"}</a></div><p className="text-xs leading-5 text-slate-500">{en ? "The website identifier is public, not an API secret. Website URL is descriptive, not domain-based access control. Do not pass private customer identifiers through unsigned widget JavaScript." : "网站标识是公开信息，不是 API 密钥。网站地址用于配置展示，不作为域名鉴权；请勿通过未签名的组件脚本传入敏感客户身份。"}</p></div> : <form onSubmit={event => void create(event)} className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-sm">{en ? "Website name" : "网站客服名称"}<input name="display_name" required maxLength={80} placeholder={en ? "Customer support" : "例如：官网客服"} className="mt-1 w-full rounded-lg border p-2"/></label><label className="text-sm">{en ? "Website URL (HTTPS)" : "网站地址（HTTPS）"}<input name="website_url" type="url" required placeholder="https://www.example.com" className="mt-1 w-full rounded-lg border p-2"/></label><button disabled={busy || !!error} className="rounded-lg bg-blue-600 p-2 text-sm font-semibold text-white disabled:opacity-50 sm:col-span-2">{busy ? (en ? "Configuring…" : "配置中…") : (en ? "Create website channel" : "创建网站聊天渠道")}</button></form>}
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    <p className="mt-3 text-xs leading-5 text-slate-500">{en ? "First release: one website channel per workspace, counted toward your channel allowance. Visitor messages are real conversations; private notes are never shown to visitors. Automatic AI replies remain off." : "首版每个企业支持一个网站聊天渠道，计入套餐渠道额度。测试页消息会创建真实会话；私人便笺不展示给访客。AI 自动回复保持关闭。"}</p>
  </section>;
}
