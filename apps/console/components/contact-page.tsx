import Image from "next/image";
import { RegistrationLinks } from "./registration-links";
import { ArrowLeft, BookOpen, Mail, MessageCircleMore, ShieldCheck } from "lucide-react";
import { BrandLogo } from "./brand-logo";
import { PublicLocaleLink } from "./public-locale";
import { replyNestOperator } from "../lib/public-i18n";

export function ContactPage({ locale }: { locale: "zh" | "en" }) {
  const en = locale === "en";
  const home = en ? "/en" : "/";
  const alternate = en ? "/contact" : "/en/contact";
  const subject = encodeURIComponent(en ? "ReplyNest support request" : "答巢客服咨询");

  return (
    <div lang={en ? "en" : "zh-CN"} className="min-h-screen bg-[radial-gradient(circle_at_12%_0%,#e9f5ff_0,transparent_38%),var(--surface-app)] text-[var(--ink-950)]">
      <header className="border-b border-blue-100/80 bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex h-[72px] max-w-6xl items-center justify-between px-5 lg:px-8">
          <a href={home} aria-label={en ? "ReplyNest home" : "答巢首页"}><BrandLogo priority className="h-9 w-[158px] sm:w-[176px]" /></a>
          <div className="flex items-center gap-2 text-sm">
            <PublicLocaleLink locale={en ? "zh-CN" : "en"} href={alternate} className="rounded-xl px-3 py-2 font-semibold text-slate-600 hover:bg-slate-50">{en ? "中文" : "EN"}</PublicLocaleLink>
            <a href={home} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 font-semibold text-slate-700"><ArrowLeft size={16} />{en ? "Home" : "返回官网"}</a>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-8 px-5 py-12 lg:grid-cols-[minmax(0,1fr)_360px] lg:px-8 lg:py-20">
        <section>
          <p className="text-sm font-semibold text-[var(--brand-700)]">{en ? "ReplyNest support" : "答巢客户支持"}</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-.04em] sm:text-4xl">{en ? "Talk to our support team" : "联系我们"}</h1>
          <p className="mt-5 max-w-2xl text-base leading-8 text-slate-600">
            {en ? "For product trials, channel onboarding, account issues or privacy requests, contact us by email or through the ReplyNest WeChat Official Account." : "产品试用、渠道接入、账号问题或隐私请求，都可以通过客服邮箱或答巢微信公众号联系我们。"}
          </p>

          <div className="mt-9 grid gap-4 sm:grid-cols-2">
            <a href={`mailto:${replyNestOperator.supportEmail}?subject=${subject}`} className="group rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-lg">
              <span className="grid size-11 place-items-center rounded-2xl bg-blue-50 text-blue-700"><Mail size={21} /></span>
              <h2 className="mt-5 font-semibold">{en ? "Email support" : "客服邮箱"}</h2>
              <p className="mt-2 break-all text-sm text-[var(--brand-700)]">{replyNestOperator.supportEmail}</p>
              <p className="mt-3 text-xs leading-6 text-slate-500">{en ? "Best for account, billing and technical questions that need attachments or a written record." : "适合账号、账务、技术问题，以及需要附件或保留书面记录的事项。"}</p>
            </a>
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <span className="grid size-11 place-items-center rounded-2xl bg-emerald-50 text-emerald-700"><MessageCircleMore size={21} /></span>
              <h2 className="mt-5 font-semibold">{en ? "WeChat Official Account" : "微信公众号"}</h2>
              <p className="mt-2 text-sm font-medium text-slate-700">{replyNestOperator.supportWechatOfficialAccount}</p>
              <p className="mt-3 text-xs leading-6 text-slate-500">{en ? "Scan the QR code on this page in WeChat, follow the account and leave a message." : "使用微信扫描本页二维码，关注公众号后留言即可。"}</p>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-3 text-sm">
            <a href={en ? "https://docs.replynest.cn/en/" : "https://docs.replynest.cn/"} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 font-semibold text-slate-700"><BookOpen size={17} />{en ? "Help center" : "帮助文档"}</a>
            <a href={en ? "https://status.replynest.cn/en" : "https://status.replynest.cn/"} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 font-semibold text-slate-700"><ShieldCheck size={17} />{en ? "Service status" : "系统状态"}</a>
          </div>
        </section>

        <aside className="self-start rounded-[32px] border border-blue-100 bg-white p-6 text-center shadow-[0_24px_70px_-40px_rgba(22,135,248,.5)]">
          <div className="mx-auto overflow-hidden rounded-3xl border border-slate-100 bg-white p-3">
            <Image src="/wechat-support-qr.jpg" alt={en ? "QR code for the ReplyNest WeChat Official Account" : "答巢AI客服助手微信公众号二维码"} width={640} height={640} priority unoptimized className="h-auto w-full rounded-2xl" />
          </div>
          <p className="mt-5 font-semibold">{replyNestOperator.supportWechatOfficialAccount}</p>
          <p className="mt-2 text-xs leading-6 text-slate-500">{en ? "Open WeChat and scan this code. Please do not send passwords, API keys or other secrets in messages." : "打开微信扫一扫。请勿在消息中发送密码、API Key 或其他密钥。"}</p>
        </aside>
      </main>

      <footer className="border-t border-slate-200 bg-white px-5 py-7 text-center text-xs leading-6 text-slate-400">
        © 2026 {en ? replyNestOperator.displayNameEn : replyNestOperator.registeredNameZh}
        <RegistrationLinks />
      </footer>
    </div>
  );
}
