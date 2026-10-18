"use client";

import { CircleHelp, LifeBuoy, LogOut, PanelLeftClose, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BrandLogo } from "./brand-logo";
import { ConsoleNavigation } from "./console-navigation";
import { consoleText, type ConsoleLocale } from "../lib/console-i18n";

function StableIcon({ children }: { children: React.ReactNode }) {
  return <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center [transform:translateZ(0)]">{children}</span>;
}

export function MobileNavigation({ tenantName, statusPageUrl, activePath = "/", locale, role, impersonating = false }: { tenantName: string; statusPageUrl: string; activePath?: string; locale: ConsoleLocale; role: string; impersonating?: boolean }) {
  const [open, setOpen] = useState(false);
  const dialogId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const copy = consoleText(locale);
  const contactUrl = locale === "en" ? "https://replynest.cn/en/contact" : "https://replynest.cn/contact";
  const close = () => { setOpen(false); requestAnimationFrame(() => triggerRef.current?.focus()); };

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => closeRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <>
      <button type="button" ref={triggerRef} className="grid size-9 shrink-0 place-items-center rounded-lg border border-[var(--border-subtle)] lg:hidden" aria-label={copy.openNavigation} aria-controls={dialogId} aria-expanded={open} onClick={() => setOpen(true)}><PanelLeftClose className="size-[18px]" strokeWidth={1.8} /></button>
      {open && createPortal(
        <div className="fixed inset-0 z-[100] isolate lg:hidden" role="presentation">
          <button className="absolute inset-0 bg-slate-950/35 backdrop-blur-[1px]" aria-label={copy.closeBackdrop} onClick={close} />
          <aside id={dialogId} role="dialog" aria-modal="true" aria-label={copy.mobileNavigation} className="absolute inset-y-0 left-0 flex h-dvh w-[min(86vw,320px)] flex-col overflow-hidden bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl [transform:translateZ(0)]">
            <div className="flex h-16 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4"><BrandLogo href="/" priority className="h-9 w-[172px] [transform:translateZ(0)]" /><button ref={closeRef} type="button" className="grid size-9 shrink-0 place-items-center rounded-lg hover:bg-slate-100" aria-label={copy.closeNavigation} onClick={close}><X className="size-[19px]" strokeWidth={1.8} /></button></div>
            <a href="/workspaces" onClick={close} aria-label={locale === "en" ? "Switch workspace" : "切换企业"} className="mx-3 mt-4 block shrink-0 rounded-xl border border-[var(--border-subtle)] px-3 py-2.5 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-500"><div className="flex items-center justify-between text-xs text-[var(--ink-500)]"><span>{copy.currentWorkspace}</span><span className="text-[var(--brand-700)]">{locale === "en" ? "Switch →" : "切换企业 →"}</span></div><div className="mt-0.5 truncate text-sm font-medium">{tenantName}</div></a>
            <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3 [scrollbar-gutter:stable]" aria-label={copy.mobileNavigation}>
              <ConsoleNavigation activePath={activePath} role={role} impersonating={impersonating} locale={locale} onNavigate={close} mobile/>
            </nav>
            <div className="shrink-0 border-t border-[var(--border-subtle)] p-3">
              <a href={contactUrl} onClick={close} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-3 text-sm text-[var(--ink-500)] hover:bg-slate-50"><StableIcon><LifeBuoy className="size-[18px]" strokeWidth={1.8} /></StableIcon>{copy.contact}</a>
              <a href={statusPageUrl} onClick={close} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-3 text-sm text-[var(--ink-500)] hover:bg-slate-50"><StableIcon><CircleHelp className="size-[18px]" strokeWidth={1.8} /></StableIcon>{copy.status}</a>
              <form action="/api/auth/logout" method="post"><button type="submit" className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-3 text-sm text-[var(--ink-500)] hover:bg-slate-50"><StableIcon><LogOut className="size-[18px]" strokeWidth={1.8} /></StableIcon>{copy.signOut}</button></form>
            </div>
          </aside>
        </div>,
        document.body,
      )}
    </>
  );
}
