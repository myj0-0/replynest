import { ArrowRight, ArrowLeftRight, CircleHelp, Headphones, LifeBuoy, LogOut } from "lucide-react";
import { BrandLogo } from "./brand-logo";
import { ConsoleLocaleSwitch } from "./console-locale-switch";
import { MobileNavigation } from "./mobile-navigation";
import { ConsoleNavigation } from "./console-navigation";
import { consoleText } from "../lib/console-i18n";
import { getConsoleLocale } from "../lib/console-locale-server";
import { PwaInstall } from "./pwa-install";

type Session = { user: { display_name: string }; workspaces: Array<unknown>; selected_tenant_id: string | null; impersonation?: { id: string; admin_name: string | null } | null };
type Workspace = { tenant_id: string; tenant_name: string; role: string };

function StableIcon({ children }: { children: React.ReactNode }) {
  return <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center [transform:translateZ(0)]">{children}</span>;
}

export async function ConsoleShell({ session, workspace, activePath, statusPageUrl, pwaInstallEligible = false, children }: { session: Session; workspace: Workspace; activePath: string; statusPageUrl: string; pwaInstallEligible?: boolean; children: React.ReactNode }) {
  const locale = await getConsoleLocale();
  const copy = consoleText(locale);
  const contactUrl = locale === "en" ? "https://replynest.cn/en/contact" : "https://replynest.cn/contact";

  return (
    <div lang={locale === "en" ? "en" : "zh-CN"} className="fixed inset-0 overflow-hidden bg-[var(--surface-app)] text-[var(--ink-900)] lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="hidden h-full w-[248px] shrink-0 overflow-hidden border-r border-[var(--border-subtle)] bg-white lg:flex lg:flex-col [transform:translateZ(0)]">
        <div className="h-16 shrink-0 border-b border-[var(--border-subtle)] px-5 pt-3"><BrandLogo href="/" priority className="[transform:translateZ(0)]" /></div>
        <div className="shrink-0 p-3"><a href="/workspaces" aria-label={locale === "en" ? "Switch workspace" : "切换企业"} className="block rounded-xl border border-[var(--border-subtle)] p-3 hover:border-blue-300 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-500"><span className="flex items-center justify-between gap-2 text-xs text-[var(--ink-500)]"><span>{copy.currentWorkspace}</span><span className="inline-flex items-center gap-1 text-[var(--brand-700)]"><ArrowLeftRight size={13} aria-hidden="true" />{locale === "en" ? "Switch" : "切换"}</span></span><p className="mt-1 truncate text-sm font-medium">{workspace.tenant_name}</p></a></div>
        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-1 [scrollbar-gutter:stable]" aria-label={locale === "en" ? "Primary navigation" : "主导航"}>
          <ConsoleNavigation activePath={activePath} role={workspace.role} impersonating={Boolean(session.impersonation)} locale={locale}/>
        </nav>
        <div className="shrink-0 border-t border-[var(--border-subtle)] p-3">
          <a href={contactUrl} className="flex min-h-10 items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-[var(--ink-700)] hover:bg-slate-50"><StableIcon><LifeBuoy className="size-[18px]" strokeWidth={1.8} /></StableIcon>{copy.contact}</a>
          <a href={statusPageUrl} className="flex min-h-10 items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-[var(--ink-700)] hover:bg-slate-50"><StableIcon><CircleHelp className="size-[18px]" strokeWidth={1.8} /></StableIcon>{copy.status}</a>
          <form action="/api/auth/logout" method="post"><button type="submit" className="flex min-h-10 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-[var(--ink-700)] hover:bg-slate-50"><StableIcon><LogOut className="size-[18px]" strokeWidth={1.8} /></StableIcon>{copy.signOut}</button></form>
        </div>
      </aside>

      <div className="flex h-full min-w-0 flex-col overflow-hidden">
        {session.impersonation && <div className="z-30 shrink-0 bg-amber-400 px-4 py-2 text-center text-xs font-semibold text-amber-950">{copy.impersonation(session.impersonation.admin_name ?? copy.unknownAdmin)}</div>}
        <header className="z-20 flex h-16 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] bg-white/95 px-3 backdrop-blur md:px-7">
          <div className="flex min-w-0 items-center gap-3"><MobileNavigation activePath={activePath} tenantName={workspace.tenant_name} statusPageUrl={statusPageUrl} locale={locale} role={workspace.role} impersonating={Boolean(session.impersonation)} /><div className="hidden min-w-0 md:block"><p className="truncate text-base font-semibold">{copy.hello}，{session.user.display_name}</p><p className="text-xs text-[var(--ink-500)]">{copy.overview}</p></div></div>
          <div className="flex shrink-0 items-center gap-2"><PwaInstall locale={locale} tenantId={workspace.tenant_id} contextualEligible={pwaInstallEligible} /><ConsoleLocaleSwitch locale={locale} label={copy.language} compact /><a href="/workbench" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--brand-500)] px-3 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-[var(--brand-700)] sm:gap-2 sm:px-4"><Headphones className="size-4 shrink-0" /><span className="sm:hidden">{copy.workbenchShort}</span><span className="hidden sm:inline">{copy.workbench}</span><ArrowRight className="size-4 shrink-0" /></a></div>
        </header>
        <div className="console-content min-h-0 flex-1 overflow-y-auto [overscroll-behavior:contain] [scrollbar-gutter:stable]">{children}</div>
      </div>
    </div>
  );
}
