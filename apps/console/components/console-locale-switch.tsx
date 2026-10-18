"use client";

import { Languages } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { ConsoleLocale } from "../lib/console-i18n";

export function ConsoleLocaleSwitch({ locale, label, compact = false }: { locale: ConsoleLocale; label: string; compact?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function change(next: ConsoleLocale) {
    document.cookie = `replynest.console.locale=${next}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
    startTransition(() => router.refresh());
  }

  return (
    <button type="button" disabled={pending} onClick={() => change(locale === "zh" ? "en" : "zh")} aria-label={`${label}: ${locale === "zh" ? "中文" : "English"}`} className={`flex items-center rounded-xl text-sm text-[var(--ink-700)] hover:bg-slate-50 disabled:opacity-60 ${compact ? "gap-2 px-2 py-2" : "gap-3 px-3 py-2.5"}`} title={label}>
      <span className="grid size-5 shrink-0 place-items-center"><Languages aria-hidden="true" className="size-[18px]" strokeWidth={1.8} /></span>
      {!compact && <span className="min-w-0 flex-1">{label}</span>}
      <span className="text-xs font-semibold">{locale === "zh" ? "中文" : "English"}</span>
    </button>
  );
}
