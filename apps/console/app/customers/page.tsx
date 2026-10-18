import { ConsolePageHeading } from "../../components/console-page-heading";
import { ContactRound, Mail, Phone, RadioTower } from "lucide-react";
import { redirect } from "next/navigation";
import { ConsoleShell } from "../../components/console-shell";
import { fetchConsoleSession, gatewayUrl, sessionToken } from "../../lib/console-session";
import { getConsoleLocale } from "../../lib/console-locale-server";

export const dynamic = "force-dynamic";

type Customer = {
  customer_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  attributes: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
};

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const locale = await getConsoleLocale(); const en = locale === "en";
  const session = await fetchConsoleSession();
  const token = await sessionToken();
  if (!session || !token) redirect("/login?error=expired");
  const workspace = session.workspaces.find(item => item.tenant_id === session.selected_tenant_id);
  if (!workspace) redirect("/workspaces");
  const requestedPage = Math.max(1, Number((await searchParams).page ?? "1") || 1);
  const upstream = await fetch(gatewayUrl(`/api/v1/customers?page=${requestedPage}&limit=50`), {
    headers: { authorization: `Bearer ${token}` }, cache: "no-store"
  });
  if (upstream.status === 401) redirect("/login?error=expired");
  const body = await upstream.json() as { data?: Customer[]; pagination?: { page: number; has_next: boolean } };
  const customers = body.data ?? [];

  return <ConsoleShell session={session} workspace={workspace} activePath="/customers" statusPageUrl={process.env.STATUS_PUBLIC_URL ?? "http://localhost:3300"}>
    <main className="mx-auto min-h-screen max-w-6xl p-4 md:p-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div><ConsolePageHeading icon="customers">{en ? "Customers" : "客户"}</ConsolePageHeading><p className="mt-2 text-sm text-[var(--ink-500)]">{en ? "Manage customer profiles, contact details and notes from all your channels." : "统一管理各渠道客户，查看联系方式、客户资料与服务备注。"}</p></div>
        <span className="self-start rounded-full bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700">{en ? `${customers.length} on this page` : `本页 ${customers.length} 位`}</span>
      </div>
      <section className="mt-5 rounded-xl border border-[var(--border-subtle)] bg-white p-4"><form action="/workbench" method="get" role="search" className="flex flex-wrap gap-3"><input type="hidden" name="status" value="all"/><input aria-label={en?'Find customers and notes in workbench':'在工作台查找客户和备注'} name="profile" maxLength={120} className="min-w-0 flex-1 rounded-lg border p-2.5 text-sm" placeholder={en?'Name, contact, human or AI notes':'姓名、联系方式、人工或 AI 备注'}/><button className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white">{en?'Search conversations':'查找会话与备注'}</button></form><p className="mt-2 text-xs text-slate-500">{en?'Search uses the existing workbench permission scope. Open a conversation to view or correct saved AI notes; searching does not generate them.':'复用工作台现有权限范围；打开会话后可查看或纠正已有 AI 备注，搜索不生成画像、不扣点。'}</p>{workspace.role!=='agent'&&!session.impersonation&&process.env.CONSOLE_CUSTOMER_INSIGHTS_ENABLED==='true'&&<a className="mt-3 inline-block text-sm text-blue-700" href="/#customer-insights">{en?'View recent customer and question analysis →':'查看近期客户画像与问题分析 →'}</a>}</section>
      <section className="mt-6 overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-white shadow-[var(--shadow-card)]">
        {customers.length === 0 ? <div className="grid min-h-64 place-items-center p-8 text-center"><div><ContactRound className="mx-auto text-slate-300" size={38}/><p className="mt-3 font-semibold">{en ? "No customers yet" : "还没有客户"}</p><p className="mt-1 text-sm text-[var(--ink-500)]">{en ? "Customers appear here after a channel is connected and receives its first message." : "公众号接入并收到第一条消息后，客户会出现在这里。"}</p></div></div> :
        <><div className="divide-y divide-[var(--border-subtle)] md:hidden">{customers.map(customer=><article key={customer.customer_id} className="min-w-0 space-y-2 p-4"><p className="break-words font-semibold">{customer.name}</p><p className="text-xs text-[var(--ink-500)]">{String(customer.attributes?.source??customer.attributes?.channel??(en?'Channel conversation':'渠道会话'))}</p>{customer.phone&&<p className="break-all text-sm">{customer.phone}</p>}{customer.email&&<p className="break-all text-sm">{customer.email}</p>}<p className="text-xs text-[var(--ink-500)]">{en?'Last interaction':'最近互动'}：{new Date(customer.last_seen_at).toLocaleString(en?'en':'zh-CN')}</p><details className="text-xs text-[var(--ink-500)]"><summary className="cursor-pointer">{en?'Customer identifier & first seen':'客户编号与首次出现'}</summary><code className="mt-2 block break-all">{customer.customer_id}</code><p className="mt-1">{new Date(customer.first_seen_at).toLocaleString(en?'en':'zh-CN')}</p></details></article>)}</div><div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-slate-50 text-xs text-[var(--ink-500)]"><tr><th className="px-5 py-3 font-medium">{en ? "Customer" : "客户"}</th><th className="px-5 py-3 font-medium">{en ? "Contact" : "联系方式"}</th><th className="px-5 py-3 font-medium">{en ? "Source" : "来源线索"}</th><th className="px-5 py-3 font-medium">{en ? "First seen" : "首次出现"}</th><th className="px-5 py-3 font-medium">{en ? "Last interaction" : "最近互动"}</th></tr></thead><tbody>{customers.map(customer => <tr key={customer.customer_id} className="border-t border-[var(--border-subtle)]"><td className="px-5 py-4"><p className="font-semibold">{customer.name}</p><code className="mt-1 block text-[11px] text-slate-400">{customer.customer_id}</code></td><td className="px-5 py-4 text-[var(--ink-500)]">{customer.phone ? <span className="flex items-center gap-1.5"><Phone size={14}/>{customer.phone}</span> : null}{customer.email ? <span className="mt-1 flex items-center gap-1.5"><Mail size={14}/>{customer.email}</span> : null}{!customer.phone && !customer.email ? "—" : null}</td><td className="px-5 py-4"><span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs"><RadioTower size={13}/>{String(customer.attributes?.source ?? customer.attributes?.channel ?? (en ? "Channel conversation" : "渠道会话"))}</span></td><td className="px-5 py-4 text-[var(--ink-500)]">{new Date(customer.first_seen_at).toLocaleString(en ? "en" : "zh-CN")}</td><td className="px-5 py-4 text-[var(--ink-500)]">{new Date(customer.last_seen_at).toLocaleString(en ? "en" : "zh-CN")}</td></tr>)}</tbody></table></div></>}
      </section>
      <div className="mt-5 flex justify-end gap-2"><a aria-disabled={requestedPage <= 1} href={requestedPage <= 1 ? undefined : `/customers?page=${requestedPage - 1}`} className={`rounded-xl border px-4 py-2 text-sm ${requestedPage <= 1 ? "pointer-events-none text-slate-300" : "bg-white"}`}>{en ? "Previous" : "上一页"}</a><a aria-disabled={!body.pagination?.has_next} href={body.pagination?.has_next ? `/customers?page=${requestedPage + 1}` : undefined} className={`rounded-xl border px-4 py-2 text-sm ${body.pagination?.has_next ? "bg-white" : "pointer-events-none text-slate-300"}`}>{en ? "Next" : "下一页"}</a></div>
    </main>
  </ConsoleShell>;
}
