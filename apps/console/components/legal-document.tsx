import { BrandLogo } from "./brand-logo";
import { publicLocale } from "../lib/public-i18n";

export function LegalDocument({title,version,effectiveDate="2026-09-13",locale="zh",alternateHref,children}:{title:string;version:string;effectiveDate?:string;locale?:"zh"|"en";alternateHref:string;children:React.ReactNode}){
  const en=locale==="en";
  const route=publicLocale[en?"en":"zh"];
  return <main lang={route.htmlLang} className="min-h-screen bg-[var(--surface-subtle)] px-4 py-8 text-[var(--ink-900)] sm:py-12"><article className="mx-auto max-w-3xl rounded-3xl border border-[var(--border-subtle)] bg-white p-6 shadow-[var(--shadow-card)] sm:p-10"><div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border-subtle)] pb-6"><a href={route.home}><BrandLogo priority className="h-10 w-[176px]"/></a><div className="flex items-center gap-4 text-sm font-medium text-[var(--brand-700)]"><a href={alternateHref}>{en?"中文":"English"}</a><a href={route.home}>{en?"Back to home":"返回首页"}</a></div></div><p className="mt-7 inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800">{en?"Current published template":"当前发布模板"}</p><h1 className="mt-4 text-3xl font-semibold">{title}</h1><p className="mt-2 text-sm text-[var(--ink-500)]">{en?`Version: ${version} · Effective date: ${effectiveDate}`:`版本：${version} · 生效日期：${effectiveDate}`}</p><div className="legal-copy mt-8 space-y-7 text-sm leading-7 text-[var(--ink-700)]">{children}</div></article></main>;
}

export function LegalSection({title,children}:{title:string;children:React.ReactNode}){return <section><h2 className="text-lg font-semibold text-[var(--ink-900)]">{title}</h2><div className="mt-2 space-y-2">{children}</div></section>}
