import type { Metadata } from "next";
import { KeyRound } from "lucide-react";
import { ConsoleLocaleSwitch } from "../../components/console-locale-switch";
import { getConsoleLocale } from "../../lib/console-locale-server";

// Keep the reset token out of Referer without making a browser form POST's
// Origin opaque (Chromium sends Origin: null under no-referrer).
// The reset endpoint continues to enforce the configured exact origin.
export const metadata: Metadata = { referrer: "strict-origin" };
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const locale = await getConsoleLocale(); const en = locale === "en"; const params = await searchParams; const token = params.token ?? "";
  return <main lang={en ? "en" : "zh-CN"} className="relative flex min-h-screen items-center justify-center p-5"><div className="absolute right-4 top-4 rounded-xl border bg-white shadow-sm"><ConsoleLocaleSwitch locale={locale} label={en ? "Language" : "语言"} compact/></div><section className="w-full max-w-md rounded-3xl border border-[var(--border-subtle)] bg-white p-7 shadow-[var(--shadow-card)]"><div className="grid size-11 place-items-center rounded-2xl bg-[var(--brand-50)] text-[var(--brand-700)]"><KeyRound size={21}/></div><h1 className="mt-5 text-2xl font-semibold">{en ? "Set a new password" : "设置新密码"}</h1><p className="mt-2 text-sm text-[var(--ink-500)]">{en ? "After a successful reset, console sessions on your other devices will be revoked." : "重置成功后，其他设备上的 Console Session 会全部失效。"}</p>{params.error && <div role="alert" className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{en ? "The link expired or the password does not meet the requirements." : "链接已失效或密码不符合要求。"}</div>}<form action="/api/auth/reset-password" method="post" className="mt-6"><input type="hidden" name="token" value={token}/><label className="text-sm font-medium">{en ? "New password" : "新密码"}<input name="password" type="password" minLength={12} maxLength={128} required autoComplete="new-password" placeholder={en ? "12–128 characters" : "12–128 位"} className="mt-2 w-full rounded-xl border border-[var(--border-subtle)] px-3.5 py-3"/></label><button className="mt-5 w-full rounded-xl bg-[var(--brand-500)] px-4 py-3 text-sm font-semibold text-white">{en ? "Reset password" : "确认重置"}</button></form></section></main>;
}
