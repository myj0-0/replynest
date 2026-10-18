import { ArrowRight, LockKeyhole, ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";
import { fetchConsoleSession } from "../../lib/console-session";
import { BrandLogo } from "../../components/brand-logo";
import { CaptchaWidget } from "../../components/captcha-widget";
import { ConsoleLocaleSwitch } from "../../components/console-locale-switch";
import { getConsoleLocale } from "../../lib/console-locale-server";
import { PwaInstall } from "../../components/pwa-install";

export const dynamic = "force-dynamic";

const errorMessages: Record<string, { zh: string; en: string }> = {
  invalid_credentials: { zh: "邮箱或密码错误，请重新输入。", en: "The email or password is incorrect." },
  no_active_workspace: { zh: "当前账号没有可用的企业工作区。", en: "This account has no active workspace." },
  unavailable: { zh: "登录服务暂时不可用，请稍后重试。", en: "Sign-in is temporarily unavailable. Please try again later." },
  captcha_required: { zh: "人机验证未通过或已失效，请重新验证。", en: "Human verification failed or expired. Please verify again." },
  expired: { zh: "登录已失效，请重新登录。", en: "Your session expired. Please sign in again." }
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; install?: string }> }) {
  const locale = await getConsoleLocale();
  const en = locale === "en";
  const session = await fetchConsoleSession();
  if (session) redirect(session.selected_tenant_id ? "/" : "/workspaces");
  const params = await searchParams;
  const error = params.error ? errorMessages[params.error]?.[locale] : undefined;
  const demoEnabled = process.env.CONSOLE_DEMO_LOGIN === "true";
  const captchaSiteKey = process.env.CAPTCHA_SITE_KEY;

  return (
    <main lang={en ? "en" : "zh-CN"} className="relative grid min-h-screen lg:grid-cols-[minmax(0,1.05fr)_minmax(420px,0.95fr)]">
      <div className="absolute right-4 top-4 z-10 flex items-center gap-2"><PwaInstall locale={locale} openOnLoad={params.install === "1"} /><div className="rounded-xl border border-slate-200 bg-white/90 shadow-sm"><ConsoleLocaleSwitch locale={locale} label={en ? "Language" : "语言"} compact /></div></div>
      <section className="hidden bg-gradient-to-br from-[var(--brand-700)] via-[var(--brand-600)] to-[var(--ai)] p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div><div className="inline-flex rounded-2xl bg-white px-4 py-2 shadow-sm"><BrandLogo href="https://replynest.cn/" priority className="h-10 w-[176px]" /></div><p className="mt-3 text-sm text-white/70">{en ? "Customer support operations, with WeChat first" : "微信公众号优先的客服运营平台"}</p></div>
        <div className="max-w-xl"><p className="text-sm font-semibold text-blue-100">{en ? "One entry point for operations and support" : "一个入口，完成运营与接待"}</p><h1 className="mt-4 text-4xl font-semibold leading-tight">{en ? "See the service picture first, then handle every conversation in the support workspace." : "先看清服务全局，再进入客服工作台处理每一次对话。"}</h1><p className="mt-5 leading-7 text-white/75">{en ? "Workspace, channel status, AI suggestions and Chatwoot conversations share the same verified identity context." : "企业工作区、渠道状态、AI 建议与 Chatwoot 会话处理保持同一身份上下文。"}</p></div>
        <div className="flex items-center gap-2 text-sm text-white/70"><ShieldCheck size={17} />{en ? "Member and workspace permissions are checked in real time" : "企业成员与工作区权限实时校验"}</div>
      </section>
      <section className="flex items-center justify-center p-5 sm:p-10">
        <div className="w-full max-w-md rounded-3xl border border-[var(--border-subtle)] bg-white p-6 shadow-[var(--shadow-card)] sm:p-9">
          <div className="mb-8 lg:hidden"><BrandLogo href="https://replynest.cn/" priority className="h-10 w-[176px]" /><p className="mt-1 text-xs text-[var(--ink-500)]">{en ? "Operations console" : "运营中心"}</p></div>
          <div className="grid size-11 place-items-center rounded-2xl bg-[var(--brand-50)] text-[var(--brand-700)]"><LockKeyhole size={21} /></div>
          <h2 className="mt-5 text-2xl font-semibold">{en ? "Sign in to the operations console" : "登录运营中心"}</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--ink-500)]">{en ? "The server selects your authorized workspace after sign-in; the browser cannot choose a tenant identity." : "登录后由服务端确定您的企业工作区，不接受浏览器指定企业身份。"}</p>
          {error && <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
          <form action="/api/auth/login" method="post" className="mt-6 space-y-4">
            <label className="block text-sm font-medium">{en ? "Email" : "邮箱"}<input name="email" type="email" autoComplete="username" required className="mt-2 w-full rounded-xl border border-[var(--border-subtle)] bg-white px-3.5 py-3 outline-none focus:border-[var(--brand-500)]" placeholder="name@example.com" /></label>
            <label className="block text-sm font-medium">{en ? "Password" : "密码"}<input name="password" type="password" autoComplete="current-password" required minLength={12} className="mt-2 w-full rounded-xl border border-[var(--border-subtle)] bg-white px-3.5 py-3 outline-none focus:border-[var(--brand-500)]" placeholder={en ? "At least 12 characters" : "至少 12 位"} /></label>
            <CaptchaWidget siteKey={captchaSiteKey} locale={locale} />
            <div className="flex items-center justify-between"><a href={en ? "https://replynest.cn/en/contact" : "https://replynest.cn/contact"} className="text-xs font-medium text-[var(--brand-700)]">{en ? "Contact support" : "联系客服"}</a><a href="/forgot-password" className="text-xs font-medium text-[var(--brand-700)]">{en ? "Forgot password?" : "忘记密码？"}</a></div>
            <button type="submit" className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--brand-500)] px-4 py-3 text-sm font-semibold text-white hover:bg-[var(--brand-600)]">{en ? "Sign in" : "登录"}<ArrowRight size={16} /></button>
          </form>
          {demoEnabled && <form action="/api/auth/demo" method="post" className="mt-3"><button type="submit" className="w-full rounded-xl border border-blue-200 bg-[var(--brand-50)] px-4 py-3 text-sm font-semibold text-[var(--brand-700)]">{en ? "Open local synthetic-data demo" : "进入本地合成数据演示"}</button></form>}
          <p className="mt-5 text-center text-sm text-[var(--ink-500)]">{en ? "No business account yet?" : "还没有企业账号？"} <a href="/register" className="font-semibold text-[var(--brand-700)]">{en ? "Create a workspace" : "创建工作区"}</a></p>
          <a href="/demo" className="mt-5 block rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-center text-sm font-semibold text-blue-700">{en ? "Explore the demo without registering" : "免注册体验 · 浏览合成数据演示"}</a>
          <p className="mt-2 text-center text-xs leading-5 text-[var(--ink-500)]">{en ? "Read-only synthetic examples. No sign-in, messages, model calls or charges." : "只读合成示例，不创建登录会话、不发消息、不调用模型、不扣点。"}</p>
        </div>
      </section>
    </main>
  );
}
