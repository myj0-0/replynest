import type { Metadata } from "next";
import { RegistrationLinks } from "../../components/registration-links";
import {
  ArrowRight, BellRing, BookOpenCheck, Bot, Check, ChevronRight, CircleCheckBig,
  Clock3, DatabaseZap, Headphones, MessageCircleMore, MessagesSquare, PlugZap,
  Quote, ShieldCheck, Sparkles, UsersRound, Waypoints,
} from "lucide-react";
import { BrandLogo } from "../../components/brand-logo";
import { PublicLocaleLink, PublicLocaleRouter } from "../../components/public-locale";
import styles from "./home.module.css";

import { MarketingStudio, MarketingWechat } from "../../components/marketing-studio";
import { MarketingRag } from '../../components/marketing-rag';
import { MarketingInsights } from '../../components/marketing-insights';
import { MarketingWebChat } from '../../components/marketing-web-chat';
import { DemoEntry } from '../../components/public-demo';

export const metadata: Metadata = {
  title: "答巢 ReplyNest｜AI 客服、客户洞察与业务自动化平台",
  description: "答巢 ReplyNest 连接微信公众号与网站聊天，提供知识库自动接待、人工协作、AI 客户备注与问题画像，并用 AI 定制工坊搭建业务表单、图表和授权工作流。",
  keywords: ["ReplyNest", "答巢", "微信公众号客服", "网站客服", "Web Chat", "智能客服", "AI客服助手", "公众号客服系统", "多渠道客服", "客服SaaS"],
  alternates: { canonical: "https://replynest.cn/", languages: { "zh-CN": "https://replynest.cn/", en: "https://replynest.cn/en" } },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website", locale: "zh_CN", url: "https://replynest.cn/", siteName: "答巢 ReplyNest",
    title: "答巢 ReplyNest｜AI 客服、客户洞察与业务自动化平台",
    description: "从知识库自动接待到客户洞察，让咨询、协作与业务工作流连起来。",
    images: [{ url: "https://replynest.cn/og.png", width: 1729, height: 910, alt: "答巢 ReplyNest" }],
  },
  twitter: { card: "summary_large_image", title: "答巢 ReplyNest｜AI 客服、客户洞察与业务自动化平台", description: "知识库自动接待、AI 客户备注、问题画像与授权工作流", images: ["https://replynest.cn/og.png"] },
};

const features = [
  { icon: MessagesSquare, title: "公众号与网站消息统一接待", text: "公众号与 Web Chat 咨询统一进入客服工作台；会话、客户与渠道身份全程可追踪。", tone: "bg-blue-50 text-blue-700" },
  { icon: Bot, title: "知识库自动接待与人工协作", text: "管理员授权后，AI 核对知识来源与风险，回答符合阈值的常见问题；证据不足或高风险时转人工，也可选择只生成草稿。", tone: "bg-violet-50 text-violet-700" },
  { icon: BookOpenCheck, title: "企业知识与临时规则", text: "产品资料、FAQ 与限时政策分层管理；过期规则自动退出推荐上下文，历史聊天只作表达参考。", tone: "bg-cyan-50 text-cyan-700" },
  { icon: BellRing, title: "离开网页也不错过", text: "支持浏览器推送、飞书、企业微信、钉钉与自定义 Webhook，按未处理时长逐级提醒。", tone: "bg-amber-50 text-amber-700" },
  { icon: UsersRound, title: "适合团队协作", text: "管理员、主管与客服角色分离，成员邀请、工作区切换和关键操作都有审计记录。", tone: "bg-emerald-50 text-emerald-700" },
  { icon: ShieldCheck, title: "租户隔离与安全边界", text: "每次查询、知识检索、AI 上下文、通知和审计都带企业边界，敏感凭据不下发浏览器。", tone: "bg-slate-100 text-slate-700" },
];

const steps = [
  { number: "01", title: "选择接入方式", text: "嵌入网站 Web Chat、申请共享公众号，或连接自己的公众号。" },
  { number: "02", title: "导入企业知识", text: "上传资料，审核临时规则和适用范围。" },
  { number: "03", title: "选择接待与自动化方式", text: "使用人工辅助、自动草稿，或按渠道授权知识库自动接待；客户洞察单独授权。" },
];

export default function MarketingHome() {
  const schema = {
    "@context": "https://schema.org", "@type": "SoftwareApplication", name: "答巢 ReplyNest",
    alternateName: ["ReplyNest", "答巢"], applicationCategory: "BusinessApplication", operatingSystem: "Web",
    url: "https://replynest.cn/", description: "连接微信公众号与网站聊天的 AI 客服、客户洞察与业务自动化平台。",
    publisher: { "@type": "Organization", name: "答巢 ReplyNest", url: "https://replynest.cn/" },
  };
  return <div className={`${styles.page} min-h-screen overflow-hidden text-[var(--ink-950)]`}>
    <PublicLocaleRouter />
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, "\\u003c") }} />
    <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2">跳到主要内容</a>

    <header className="sticky top-0 z-50 border-b border-blue-100/80 bg-white/85 backdrop-blur-xl">
      <div className="mx-auto flex h-[72px] max-w-[1200px] items-center justify-between gap-2 px-3 sm:px-5 lg:px-8">
        <a href="/" aria-label="答巢 ReplyNest 首页" className="shrink-0 [&>span]:h-6 [&>span]:w-[110px] sm:[&>span]:h-9 sm:[&>span]:w-[176px]"><BrandLogo priority className="h-6 w-[110px] sm:h-9 sm:w-[176px]" /></a>
        <nav className="hidden items-center gap-4 text-sm font-medium text-slate-600 xl:flex" aria-label="官网导航">
          <a href="#features" className="transition hover:text-blue-600">产品能力</a><a href="#ai-studio" className="transition hover:text-blue-600">AI 定制工坊</a><a href="#wechat-crm" className="transition hover:text-blue-600">微信 CRM</a><a href="#web-chat" className="transition hover:text-blue-600">网站客服</a><a href="#security" className="transition hover:text-blue-600">安全可信</a><a href="https://docs.replynest.cn/" className="transition hover:text-blue-600">帮助文档</a><a href="/contact" className="transition hover:text-blue-600">联系客服</a><a href="https://status.replynest.cn/" className="transition hover:text-blue-600">系统状态</a>
        </nav>
        <div className="flex shrink-0 items-center gap-0.5 sm:gap-2"><PublicLocaleLink locale="en" href="/en" className="rounded-xl px-1.5 py-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 sm:px-2 sm:text-sm">EN</PublicLocaleLink><a href="https://console.replynest.cn/login" className="inline-flex shrink-0 rounded-xl px-2 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 sm:px-4">登录</a><a href="https://console.replynest.cn/register" className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--brand-500)] px-2.5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-500/20 transition hover:-translate-y-0.5 hover:bg-[var(--brand-600)] sm:px-4"><span className="sm:hidden">注册</span><span className="hidden sm:inline">注册企业</span><ArrowRight size={15}/></a></div>
      </div>
    </header>

    <main id="main">
      <section className="relative">
        <div className={`${styles.gridGlow} pointer-events-none absolute inset-0`} />
        <div className="relative mx-auto grid max-w-[1200px] gap-14 px-5 pb-24 pt-16 lg:grid-cols-[.92fr_1.08fr] lg:items-center lg:px-8 lg:pb-28 lg:pt-24">
          <div className={`${styles.reveal} max-w-2xl`}>
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white/90 px-3 py-1.5 text-xs font-semibold text-blue-700 shadow-sm"><span className={`${styles.pulse} size-2 rounded-full bg-emerald-500`}/>微信公众号优先 · 人工与 AI 协作</div>
            <h1 className="mt-7 text-[clamp(2.65rem,6vw,4.6rem)] font-semibold leading-[1.05] tracking-[-.055em] text-[#06183b]">把每一次回复，<br/><span className="bg-gradient-to-r from-[#087cf0] to-[#43bff5] bg-clip-text text-transparent">变成客户信任。</span></h1>
            <p className="mt-6 max-w-xl text-base leading-8 text-slate-600 sm:text-lg">连接微信公众号与网站聊天，让知识库接待常见问题，让 AI 整理客户备注与问题画像，再用 AI 定制工坊串起团队业务。无需先认证自有公众号，也能通过共享渠道开始接待。</p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row"><a href="https://console.replynest.cn/register" className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[var(--brand-500)] px-6 py-3.5 font-semibold text-white shadow-xl shadow-blue-500/25 transition hover:-translate-y-0.5 hover:bg-[var(--brand-600)]">注册企业账号<ArrowRight size={17}/></a><a href="#features" className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-6 py-3.5 font-semibold text-slate-700 shadow-sm transition hover:border-blue-200 hover:text-blue-700">看看能做什么<ChevronRight size={17}/></a></div>
            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-sm text-slate-500"><span className="flex items-center gap-2"><Check size={16} className="text-emerald-500"/>自动接待按授权</span><span className="flex items-center gap-2"><Check size={16} className="text-emerald-500"/>按企业隔离</span><span className="flex items-center gap-2"><Check size={16} className="text-emerald-500"/>状态公开可查</span></div>
          </div>

          <div className={`${styles.reveal} ${styles.delayOne} relative mx-auto w-full max-w-[620px] lg:mx-0`} aria-label="答巢客服运营界面示意">
            <div className={`${styles.heroPanel} relative overflow-hidden rounded-[28px] border border-white/80 bg-white p-3 shadow-[0_35px_100px_-35px_rgba(10,62,126,.38)] sm:p-4`}>
              <div className="flex items-center justify-between border-b border-slate-100 px-2 pb-3"><div className="flex items-center gap-2"><BrandLogo compact/><div><p className="text-sm font-semibold">答巢运营中心</p><p className="text-[11px] text-slate-400">服务概况 · 实时更新</p></div></div><span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-600">运行正常</span></div>
              <div className="grid gap-3 pt-3 sm:grid-cols-[1.3fr_.7fr]">
                <div className="rounded-2xl bg-gradient-to-br from-blue-600 to-blue-400 p-5 text-white"><p className="text-xs text-blue-100">当前需要关注</p><p className="mt-2 text-xl font-semibold">2 条会话等待处理</p><p className="mt-2 text-xs leading-5 text-blue-50">优先级已根据等待时间与客户状态排序</p><div className="mt-5 inline-flex rounded-lg bg-white px-3 py-2 text-xs font-semibold text-blue-700">进入客服工作台</div></div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-1"><Metric label="今日咨询" value="128" note="较昨日 +12.3%"/><Metric label="AI 建议采用率" value="42%" note="人工最终确认"/></div>
              </div>
              <div className="mt-3 rounded-2xl border border-slate-100 p-4"><div className="flex items-center justify-between"><div><p className="text-sm font-semibold">AI 推荐回复</p><p className="mt-0.5 text-[11px] text-slate-400">依据当前知识与有效政策生成</p></div><Sparkles size={18} className="text-violet-500"/></div><div className="mt-3 rounded-xl bg-slate-50 p-3 text-xs leading-6 text-slate-600">该批次商品适用临时退款规则。建议先核对购买时间和订单状态，再向客户说明退款路径。</div><div className="mt-3 flex items-center justify-between text-[11px]"><span className="text-emerald-600">✓ 已引用 2 条依据</span><span className="font-semibold text-blue-600">人工确认后发送</span></div></div>
            </div>
            <div className={`${styles.floatOne} absolute -right-3 top-20 hidden rounded-2xl border border-blue-100 bg-white p-3 shadow-xl sm:block lg:-right-9`}><div className="flex items-center gap-2"><div className="grid size-8 place-items-center rounded-lg bg-blue-50 text-blue-600"><BellRing size={16}/></div><div><p className="text-xs font-semibold">新消息已提醒</p><p className="text-[10px] text-slate-400">Browser Push · 刚刚</p></div></div></div>
            <div className={`${styles.floatTwo} absolute -bottom-7 -left-3 hidden rounded-2xl border border-emerald-100 bg-white p-3 shadow-xl sm:block lg:-left-8`}><div className="flex items-center gap-2"><CircleCheckBig size={22} className="text-emerald-500"/><div><p className="text-xs font-semibold">临时规则仍在有效期</p><p className="text-[10px] text-slate-400">Policy Engine 已复核</p></div></div></div>
          </div>
        </div>
      </section>

      <section className="border-y border-blue-100 bg-white py-5" aria-label="核心能力概览"><div className="overflow-hidden"><div className={`${styles.marquee} text-sm font-semibold text-slate-400`}><div className={styles.marqueeGroup}><Ticker/></div><div className={styles.marqueeGroup} aria-hidden="true"><Ticker/></div></div></div></section>

      <DemoEntry/><MarketingWechat/><MarketingWebChat/><MarketingRag/><MarketingInsights/><MarketingStudio/>
      <section id="features" className="mx-auto max-w-[1200px] px-5 py-24 lg:px-8 lg:py-32">
        <SectionHeading eyebrow="不只是一个聊天窗口" title="从消息进入，到问题解决" text="围绕客服每天真正要做的事，把渠道、知识、判断、回复和提醒连成一条清晰工作流。"/>
        <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">{features.map(({icon:Icon,title,text,tone})=><article key={title} className="group rounded-3xl border border-slate-200/80 bg-white p-6 shadow-[0_18px_50px_-38px_rgba(8,56,118,.38)] transition duration-300 hover:-translate-y-1 hover:border-blue-200 hover:shadow-[0_22px_55px_-32px_rgba(22,135,248,.35)]"><div className={`grid size-11 place-items-center rounded-2xl ${tone}`}><Icon size={21}/></div><h3 className="mt-5 text-lg font-semibold text-[#0a2044]">{title}</h3><p className="mt-3 text-sm leading-7 text-slate-500">{text}</p></article>)}</div>
      </section>

      <section id="workflow" className="bg-[#071a3d] py-24 text-white lg:py-32"><div className="mx-auto max-w-[1200px] px-5 lg:px-8"><SectionHeading dark eyebrow="三步开始" title="让工具适应团队，而不是反过来" text="从公众号开始，逐步接入知识与协作流程；由管理员选择接待模式，并按用途和渠道授权。"/><div className="mt-14 grid gap-5 md:grid-cols-3">{steps.map((step,index)=><article key={step.number} className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[.055] p-7"><span className="text-5xl font-semibold tracking-[-.06em] text-blue-400/30">{step.number}</span><div className="mt-10 flex items-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-blue-500/15 text-blue-300">{index===0?<PlugZap size={19}/>:index===1?<DatabaseZap size={19}/>:<Headphones size={19}/>}</div><h3 className="text-lg font-semibold">{step.title}</h3></div><p className="mt-4 text-sm leading-7 text-slate-300">{step.text}</p></article>)}</div></div></section>

      <section id="security" className="mx-auto grid max-w-[1200px] gap-14 px-5 py-24 lg:grid-cols-2 lg:items-center lg:px-8 lg:py-32"><div><SectionHeading eyebrow="有依据，也有边界" title="AI 能帮忙，规则不能猜" text="答巢把企业知识、限时政策和历史表达分开处理：知识检索核对依据与风险；符合阈值的常见问题按授权回复，其余转人工。"/><div className="mt-8 space-y-4"><Trust icon={ShieldCheck} title="临时规则有期限、有范围" text="按产品批次、渠道、客户或活动范围生效，到期后自动退出决策。"/><Trust icon={Quote} title="历史知识先核对再发布" text="历史聊天可按授权整理知识草稿，必须由管理员核对发布后才能用于知识库接待。"/><Trust icon={Waypoints} title="每次建议可追溯" text="保留引用、规则版本、模型与人工反馈，便于复核和改进。"/></div></div><div className="rounded-[32px] border border-blue-100 bg-white p-5 shadow-[0_28px_80px_-45px_rgba(22,135,248,.45)] sm:p-7"><div className="flex items-center justify-between"><div><p className="text-xs font-semibold uppercase tracking-[.18em] text-blue-600">Decision flow</p><p className="mt-2 text-xl font-semibold text-[#071a3d]">推荐回复决策流水</p></div><Bot className="text-blue-500"/></div><div className="mt-8 space-y-3"><Flow number="1" title="检索正式知识" note="只读取当前企业与有效版本"/><Flow number="2" title="校验临时政策" note="检查时间、渠道、批次与客户条件"/><Flow number="3" title="参考已审核表达" note="只优化语气，不创造规则"/><Flow number="4" title="按接待模式处理" note="授权低风险自动答复；不足阈值转人工" active/></div></div></section>

      <section className="px-5 pb-24 lg:px-8 lg:pb-32"><div className="relative mx-auto max-w-[1140px] overflow-hidden rounded-[32px] bg-gradient-to-br from-blue-600 via-[#1687f8] to-cyan-400 px-6 py-14 text-center text-white shadow-2xl shadow-blue-500/25 sm:px-10 sm:py-16"><div className="pointer-events-none absolute -right-16 -top-24 size-72 rounded-full border-[42px] border-white/10"/><MessageCircleMore className="mx-auto text-blue-100" size={32}/><h2 className="mt-5 text-3xl font-semibold tracking-[-.035em] sm:text-4xl">为认真回复每一位客户而生</h2><p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-blue-50 sm:text-base">创建企业工作区，选择共享或自有公众号接入方式，再用 AI 定制工坊搭建适合团队的工具。套餐与额度以控制台展示为准。</p><div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row"><a href="https://console.replynest.cn/register" className="inline-flex items-center justify-center gap-2 rounded-2xl bg-white px-6 py-3.5 font-semibold text-blue-700 shadow-lg">注册企业<ArrowRight size={17}/></a><a href="https://console.replynest.cn/login" className="inline-flex items-center justify-center rounded-2xl border border-white/35 px-6 py-3.5 font-semibold text-white">已有账号，登录控制台</a></div></div></section>
    </main>

    <footer className="border-t border-slate-200 bg-white"><div className="mx-auto max-w-[1200px] px-5 py-10 lg:px-8"><div className="flex flex-col gap-7 sm:flex-row sm:items-start sm:justify-between"><div><BrandLogo className="h-8 w-[140px]"/><p className="mt-2 text-xs text-slate-400">AI 客服 · 客户洞察 · 业务自动化</p></div><div className="flex flex-wrap gap-x-6 gap-y-3 text-sm text-slate-500"><a href="https://console.replynest.cn/login">控制台</a><a href="https://console.replynest.cn/login?install=1">安装应用</a><a href="https://docs.replynest.cn/">帮助文档</a><a href="https://status.replynest.cn/">系统状态</a><a href="/legal/privacy">隐私政策</a><a href="/legal/terms">服务协议</a><a href="/contact">联系我们</a></div></div><div className="mt-7 border-t border-slate-100 pt-5 text-xs leading-6 text-slate-400"><p>运营主体：您的服务运营主体 · 联系邮箱：support@fs.replynest.cn</p><p>注册地址：请填写您的服务运营地址 · © 2026 答巢 ReplyNest</p><RegistrationLinks /></div></div></footer>
  </div>;
}

function Metric({label,value,note}:{label:string;value:string;note:string}) { return <div className="rounded-2xl border border-slate-100 bg-white p-3 shadow-sm"><p className="text-[10px] text-slate-400">{label}</p><p className="mt-1 text-xl font-semibold text-[#071a3d]">{value}</p><p className="mt-1 text-[10px] text-emerald-600">{note}</p></div>; }
function Ticker(){return <><span>微信公众号 CRM</span><span>AI 定制工坊</span><span>知识库自动接待</span><span>AI 客户备注与画像</span><span>企业知识库</span><span>临时规则引擎</span><span>团队协作</span><span>多端通知</span><span>租户数据隔离</span><span>公开服务状态</span></>;}
function SectionHeading({eyebrow,title,text,dark=false}:{eyebrow:string;title:string;text:string;dark?:boolean}){return <div className="max-w-2xl"><p className={`text-xs font-semibold uppercase tracking-[.2em] ${dark?"text-blue-300":"text-blue-600"}`}>{eyebrow}</p><h2 className={`mt-4 text-3xl font-semibold tracking-[-.04em] sm:text-4xl ${dark?"text-white":"text-[#071a3d]"}`}>{title}</h2><p className={`mt-5 text-base leading-8 ${dark?"text-slate-300":"text-slate-500"}`}>{text}</p></div>;}
function Trust({icon:Icon,title,text}:{icon:typeof ShieldCheck;title:string;text:string}){return <div className="flex gap-4 rounded-2xl border border-slate-200 bg-white p-4"><div className="grid size-10 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-600"><Icon size={19}/></div><div><h3 className="text-sm font-semibold text-[#071a3d]">{title}</h3><p className="mt-1 text-sm leading-6 text-slate-500">{text}</p></div></div>;}
function Flow({number,title,note,active=false}:{number:string;title:string;note:string;active?:boolean}){return <div className={`flex items-center gap-4 rounded-2xl border p-4 ${active?"border-blue-200 bg-blue-50":"border-slate-100 bg-slate-50"}`}><span className={`grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold ${active?"bg-blue-600 text-white":"bg-white text-slate-500"}`}>{number}</span><div><p className="text-sm font-semibold text-[#071a3d]">{title}</p><p className="mt-1 text-xs text-slate-500">{note}</p></div>{active&&<Clock3 size={16} className="ml-auto text-blue-500"/>}</div>;}
