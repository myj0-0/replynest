import { ArrowRight, Code2, Globe2, Headphones, MessageCircleMore, ShieldCheck } from 'lucide-react';

/** Static product illustration: never mounts a live widget or creates a conversation. */
export function MarketingWebChat({ en = false }: { en?: boolean }) {
  const cards = en ? [
    { icon: Code2, title: 'Embed on your website', text: 'Create a website channel, copy the embed code and ask your website maintainer to install it. No WeChat account is required.' },
    { icon: Headphones, title: 'One place for your team', text: 'Website and WeChat conversations enter the same workbench, with customer context, assignment and team-only private notes.' },
    { icon: ShieldCheck, title: 'Choose when AI takes over', text: 'Start with human replies or reviewed AI drafts. Administrators can separately authorize knowledge-based automatic reception for the website channel.' },
  ] : [
    { icon: Code2, title: '一段代码，接入你的网站', text: '创建网站渠道后复制嵌入代码，交给网站维护者安装。没有微信公众号，也能从网站客服开始。' },
    { icon: Headphones, title: '微信、网站，同一个工作台', text: '网站咨询与公众号会话统一接待，查看客户资料、分配负责人、记录仅团队可见的私人便笺，不必来回切换。' },
    { icon: ShieldCheck, title: '人工先用，AI 按需授权', text: '可先由人工回复或审核 AI 草稿，再由管理员为网站渠道单独授权知识库自动接待；证据不足或高风险问题交回人工。' },
  ];
  return <section id="web-chat" aria-labelledby="web-chat-title" className="scroll-mt-24 border-y border-cyan-100 bg-gradient-to-b from-cyan-50/70 to-white">
    <div className="mx-auto max-w-[1200px] px-5 py-20 lg:px-8 lg:py-24">
      <div className="grid items-center gap-10 lg:grid-cols-[1fr_1fr] lg:gap-14">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.15em] text-cyan-700"><Globe2 size={17}/>{en ? 'Website support · Web Chat' : '网站客服 · Web Chat'}</p>
          <h2 id="web-chat-title" className="mt-4 text-3xl font-semibold leading-tight tracking-[-.035em] text-[#071a3d] sm:text-4xl">{en ? 'A question on your website. A conversation with your team.' : '让网站访客的每一句咨询，都有人接住。'}</h2>
          <p className="mt-5 text-base leading-8 text-slate-600">{en ? 'Add a chat bubble to your website so visitors can ask without switching to WeChat. Your team handles the conversation in ReplyNest, with enterprise knowledge ready to help.' : '在网站放一个聊天入口，访客不用跳到微信，也能直接提问。团队在答巢客服工作台接待，再把企业知识接进回复流程。'}</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <a href="https://console.replynest.cn/register" className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-700">{en ? 'Create a workspace' : '创建工作区，接入网站'}<ArrowRight size={16}/></a>
            <a href={en ? 'https://docs.replynest.cn/en/website-chat' : 'https://docs.replynest.cn/website-chat'} className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-cyan-300 hover:text-cyan-800">{en ? 'Read the setup guide' : '查看 Web Chat 接入教程'}</a>
          </div>
        </div>
        <div className="min-w-0 rounded-[28px] border border-cyan-100 bg-white p-3 shadow-[0_24px_70px_-35px_rgba(8,145,178,.35)] sm:p-4" aria-label={en ? 'Illustration of website chat and team reception' : '网站聊天与团队接待示意'}>
          <div className="flex items-center gap-2 border-b border-slate-100 px-2 pb-3"><span className="size-2 rounded-full bg-slate-200"/><span className="size-2 rounded-full bg-slate-200"/><span className="size-2 rounded-full bg-slate-200"/><span className="ml-2 truncate rounded-md bg-slate-50 px-3 py-1 text-xs text-slate-500">{en ? 'Your business website' : '你的企业网站'}</span></div>
          <div className="relative min-h-[300px] overflow-hidden rounded-b-2xl bg-slate-50 p-4 sm:min-h-[320px] sm:p-5">
            <div aria-hidden="true" className="w-1/2 space-y-3 pt-3"><div className="h-4 w-3/4 rounded bg-slate-200"/><div className="h-2 rounded bg-slate-200/80"/><div className="h-2 w-2/3 rounded bg-slate-200/80"/><div className="mt-5 h-20 rounded-xl bg-cyan-100/70"/></div>
            <div className="relative ml-auto mt-[-100px] w-full max-w-[295px] overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-lg">
              <div className="flex items-center gap-2 bg-blue-600 px-4 py-3 text-sm font-semibold text-white"><MessageCircleMore size={18}/>{en ? 'Talk to our team' : '在线咨询'}</div>
              <div className="space-y-3 p-4 text-xs leading-6"><p className="ml-7 rounded-xl rounded-br-sm bg-blue-50 p-3 text-blue-900">{en ? 'Can I use this without a WeChat account?' : '没有公众号，也可以接入网站客服吗？'}</p><p className="mr-4 rounded-xl rounded-bl-sm bg-slate-100 p-3 text-slate-700">{en ? 'Yes. Create a website channel, then install the embed code on your site.' : '可以。创建网站渠道，把嵌入代码安装到你的网站即可。'}</p><p className="text-[11px] text-slate-500">{en ? 'Illustrative human reply · not a live conversation' : '人工回复示意 · 非真实会话'}</p></div>
            </div>
            <div className="ml-auto mt-3 flex w-fit items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-xs font-semibold text-white"><MessageCircleMore size={16}/>{en ? 'Chat with us' : '有问题？聊一聊'}</div>
          </div>
        </div>
      </div>
      <div className="mt-10 grid gap-4 md:grid-cols-3">{cards.map(({ icon: Icon, title, text }) => <article key={title} className="rounded-2xl border border-slate-200 bg-white p-5"><Icon size={21} className="text-cyan-700"/><h3 className="mt-4 text-base font-semibold text-slate-900">{title}</h3><p className="mt-2 text-sm leading-7 text-slate-600">{text}</p></article>)}</div>
      <p className="mt-5 text-xs leading-6 text-slate-500">{en ? 'Currently one website channel per tenant, counted toward the plan channel limit. Requires an HTTPS website you can edit. Installing the widget does not enable automatic AI replies; AI usage consumes points under the current plan rules. Browser storage affects visitor continuity, and a visitor name is not verified identity.' : '目前每企业支持 1 个网站渠道，计入套餐渠道额度；需有可安装代码的 HTTPS 网站。安装聊天入口不等于开启 AI 自动回复，AI 使用按当前套餐规则消耗点数。访客连续识别依赖浏览器存储，访客填写的姓名不代表已验证身份。'}</p>
    </div>
  </section>;
}
