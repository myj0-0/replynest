import { Building2, ChevronRight } from "lucide-react";
import { redirect } from "next/navigation";
import { BrandLogo } from "../../components/brand-logo";
import { ConsoleLocaleSwitch } from "../../components/console-locale-switch";
import { getConsoleLocale } from "../../lib/console-locale-server";
import { fetchConsoleSession, sessionToken } from "../../lib/console-session";

export const dynamic = "force-dynamic";
export default async function WorkspacesPage() {
  const locale = await getConsoleLocale(); const en = locale === "en"; const token = await sessionToken(); const session = await fetchConsoleSession();
  if (!session) redirect(token ? "/login?error=expired" : "/login");
  return <main lang={en ? "en" : "zh-CN"} className="relative mx-auto min-h-screen max-w-2xl p-5 sm:p-10"><div className="absolute right-5 top-5 rounded-xl border bg-white shadow-sm"><ConsoleLocaleSwitch locale={locale} label={en ? "Language" : "语言"} compact/></div><div className="pr-20"><BrandLogo priority className="h-10 w-[176px]"/><p className="mt-2 text-xs text-[var(--ink-500)]">{en ? "Select workspace" : "选择企业工作区"} · {session.user.email}</p></div><section className="mt-10 rounded-3xl border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)] sm:p-7"><h1 className="text-xl font-semibold">{en ? "Which workspace do you want to open?" : "您要进入哪个企业？"}</h1><p className="mt-2 text-sm text-[var(--ink-500)]">{en ? "Only active workspace memberships are shown." : "仅展示当前处于启用状态的成员关系。"}</p><div className="mt-6 space-y-3">{session.workspaces.map((workspace) => <form key={workspace.tenant_id} action="/api/workspaces/select" method="post"><input type="hidden" name="tenant_id" value={workspace.tenant_id}/><button className="flex w-full items-center gap-3 rounded-2xl border border-[var(--border-subtle)] p-4 text-left hover:border-blue-200 hover:bg-[var(--brand-50)]"><div className="grid size-10 place-items-center rounded-xl bg-slate-100 text-[var(--ink-700)]"><Building2 size={19}/></div><div className="min-w-0 flex-1"><p className="font-medium">{workspace.tenant_name}</p><p className="mt-1 text-xs text-[var(--ink-500)]">{roleName(workspace.role, en)}</p></div><ChevronRight size={18}/></button></form>)}</div></section></main>;
}
function roleName(role: string, en: boolean) { return ({ tenant_admin: en ? "Workspace administrator" : "企业管理员", supervisor: en ? "Supervisor" : "主管", agent: en ? "Agent" : "客服坐席" } as Record<string, string>)[role] ?? role; }
