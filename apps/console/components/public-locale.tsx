"use client";

import { useEffect, type MouseEvent, type ReactNode } from "react";

const preferenceKey = "replynest.public.locale";

export function PublicLocaleRouter() {
  useEffect(() => {
    if (window.location.pathname !== "/") return;
    let saved: string | null = null;
    try { saved = window.localStorage.getItem(preferenceKey); } catch { /* Language routing still works when storage is unavailable. */ }
    if (saved === "zh-CN" || saved === "en") return;
    const preferred = navigator.languages?.[0] ?? navigator.language;
    if (preferred && !preferred.toLowerCase().startsWith("zh")) window.location.replace("/en");
  }, []);
  return null;
}

export function PublicLocaleLink({ locale, href, children, className }: { locale: "zh-CN" | "en"; href: string; children: ReactNode; className?: string }) {
  function remember(event: MouseEvent<HTMLAnchorElement>) {
    if (!event.defaultPrevented) {
      try { window.localStorage.setItem(preferenceKey, locale); } catch { /* The link itself remains functional. */ }
    }
  }
  return <a href={href} hrefLang={locale} lang={locale} className={className} onClick={remember}>{children}</a>;
}
