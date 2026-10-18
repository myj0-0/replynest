import { ShieldAlert } from "lucide-react";
import { ConsoleShell } from "./console-shell";
import type { ConsoleSession, ConsoleWorkspace } from "../lib/console-session";
import { getConsoleLocale } from "../lib/console-locale-server";

export async function ConsoleAccessDenied({ session, workspace, activePath }: { session: ConsoleSession; workspace: ConsoleWorkspace; activePath: string }) {
  const en = (await getConsoleLocale()) === "en";
  return <ConsoleShell session={session} workspace={workspace} activePath={activePath} statusPageUrl={process.env.STATUS_PUBLIC_URL ?? "https://status.replynest.cn"}>
    <main className="mx-auto max-w-3xl p-4 md:p-8"><section role="alert" className="rounded-2xl border border-[var(--border-subtle)] bg-white p-6 shadow-sm">
      <ShieldAlert aria-hidden="true" className="text-amber-600"/>
      <h1 className="mt-4 text-xl font-semibold">{en ? "Access unavailable" : "当前账号无权访问"}</h1>
      <p className="mt-2 text-sm leading-6 text-[var(--ink-500)]">{en ? "Contact your workspace administrator if you need access. Administrator-only actions are unavailable during impersonation." : "如需使用此功能，请联系企业管理员。仅管理员本人可操作的功能不支持代登录。"}</p>
      <div className="mt-5 flex flex-wrap gap-3"><a href="/workbench" className="rounded-xl bg-[var(--brand-500)] px-4 py-2 text-sm font-semibold text-white">{en ? "Open support workspace" : "进入客服工作台"}</a><a href="/" className="rounded-xl border px-4 py-2 text-sm">{en ? "Back to home" : "返回首页"}</a></div>
    </section></main>
  </ConsoleShell>;
}
