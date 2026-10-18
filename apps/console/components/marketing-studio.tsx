import { ArrowRight, ChartNoAxesCombined, FileSliders, MessageCircleMore, QrCode, ShieldCheck, Sparkles } from "lucide-react";

/** Public examples are illustrative; they never load customer records or call a model. */
export function MarketingStudio({ en = false }: { en?: boolean }) {
  const copy = en ? {
    eyebrow: "AI Custom Studio", title: "Your business. Your tools. Your way of working.",
    intro: "Describe what your team needs. Build forms, record tables, charts and conditional workflows from supported capabilities, then review and publish a version you control.",
    prompt: "Create an after-sales form with a product, amount and priority. Mark amounts of 500 or more as priority, and chart totals by priority.",
    label: "An example you can ask AI to build", preview: "Illustrative configuration · not live customer data",
    items: [
      ["Custom forms & records", "Collect after-sales requests, consultation notes and internal tasks using fields you choose."],
      ["Charts that answer your questions", "Group your application's records into bar or date-based line charts. Count, total or average numeric fields."],
      ["Rules & workbench tools", "Set submitted fields with conditional rules, then add published forms to the support workspace."],
    ], boundary: "Review before publishing. Data stays scoped to the business and application. AI generates supported configuration, not arbitrary code; unsupported actions are not enabled by describing them.",
    docs: "Explore supported capabilities",
  } : {
    eyebrow: "AI 定制工坊", title: "业务有自己的节奏，工具也该有自己的样子。",
    intro: "用一句话描述需求，把平台已有能力组合成自己的表单、数据台账、统计图表与条件工作流。先预览、再确认发布，不必等一套标准功能适配所有行业。",
    prompt: "帮我建一个售后登记台，记录产品、金额与优先级。金额达到 500 元时标记为优先，再按优先级统计金额。",
    label: "你可以这样告诉 AI", preview: "配置示意 · 非真实客户数据",
    items: [
      ["自定义表单与数据台账", "按自己的业务字段登记售后、咨询和内部事项，让信息有处可存、有序可查。"],
      ["自定义统计图表", "基于本应用记录生成柱状图、日期折线图，按字段分组看数量、合计或平均值。"],
      ["条件逻辑与工作台工具", "按条件设置提交记录的字段，把已发布表单添加到客服工作台，边接待边登记。"],
    ], boundary: "发布前由管理员确认，数据按企业与应用隔离。AI 生成平台支持的受控配置，不执行任意代码；未开放能力不会因为一句描述就被启用。",
    docs: "查看能力与参数文档",
  };
  return <section id="ai-studio" className="scroll-mt-24 border-y border-blue-100 bg-blue-50/50 py-20 lg:py-24">
    <div className="mx-auto grid max-w-[1200px] gap-10 px-5 lg:grid-cols-2 lg:items-center lg:px-8">
      <div><p className="flex items-center gap-2 text-sm font-semibold text-blue-700"><Sparkles size={18}/>{copy.eyebrow}</p><h2 className="mt-4 text-3xl font-semibold leading-tight tracking-tight text-[#071a3d] sm:text-4xl">{copy.title}</h2><p className="mt-5 text-base leading-8 text-slate-600">{copy.intro}</p><div className="mt-7 space-y-5">{copy.items.map(([title,text],i)=>{const Icon=[FileSliders,ChartNoAxesCombined,MessageCircleMore][i];return <div key={title} className="flex gap-3"><Icon size={20} className="mt-1 shrink-0 text-blue-600"/><div><h3 className="font-semibold">{title}</h3><p className="mt-1 text-sm leading-6 text-slate-600">{text}</p></div></div>;})}</div><a href={`https://docs.replynest.cn/${en?'en/':''}platform-bricks/`} className="mt-7 inline-flex items-center gap-2 text-sm font-semibold text-blue-700 underline underline-offset-4">{copy.docs}<ArrowRight size={16}/></a></div>
      <div className="min-w-0 rounded-3xl border border-blue-100 bg-white p-6 shadow-xl shadow-blue-900/5 sm:p-8"><p className="text-xs font-semibold text-slate-500">{copy.label}</p><p className="mt-3 rounded-2xl bg-blue-50 p-5 text-base leading-7 text-blue-950">{copy.prompt}</p><div className="my-5 flex items-center gap-2 text-xs font-semibold text-blue-700"><Sparkles size={16}/>{en?'Describe → Preview → Approve → Publish':'描述需求 → 预览模拟 → 确认授权 → 发布使用'}</div><div className="grid gap-3 sm:grid-cols-2"><div className="rounded-2xl border border-slate-200 p-4"><p className="text-sm font-semibold">{en?'After-sales form':'售后登记表'}</p>{(en?['Product','Amount','Priority']:['产品','金额','优先级']).map(x=><div key={x} className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">{x}</div>)}</div><div className="rounded-2xl border border-slate-200 p-4"><p className="text-sm font-semibold">{en?'Totals by priority':'按优先级统计金额'}</p><div className="mt-5 space-y-4" aria-label={en?'Illustrative bar chart':'柱状图示意'}><div><p className="mb-1 text-xs text-slate-500">{en?'Normal':'普通'}</p><div className="h-5 w-2/5 rounded bg-blue-200"/></div><div><p className="mb-1 text-xs text-slate-500">{en?'Priority':'优先'}</p><div className="h-5 w-4/5 rounded bg-blue-500"/></div></div></div></div><p className="mt-3 text-xs text-slate-400">{copy.preview}</p><p className="mt-5 flex gap-2 border-t border-slate-100 pt-5 text-xs leading-6 text-slate-500"><ShieldCheck size={17} className="mt-1 shrink-0"/>{copy.boundary}</p></div>
    </div>
  </section>;
}

export function MarketingWechat({ en = false }: { en?: boolean }) {
  const cards = en ? [
    { title: "Start with our shared official account", tag: "No own-account certification cost", text: "Apply for the ReplyNest shared channel. Once enabled, place your merchant QR code on your website; visitors follow our official account and talk to your team.", bullets: ["Merchant-specific QR entry and conversation routing", "Agents reply from the ReplyNest workspace", "Customers choose explicitly when switching merchants"] },
    { title: "Connect your own official account", tag: "Your brand, your channel", text: "Already have an eligible official account? Configure the message URL, Token and EncodingAESKey, then connect your account credentials through the secure setup.", bullets: ["Use your own official account identity", "Keep customer profiles, notes and conversations together", "Account eligibility and WeChat fees still apply"] },
  ] : [
    { title: "共享公众号，轻装开始", tag: "0 自有公众号认证成本接入", text: "申请答巢官方共享公众号体验渠道，开通后把商家专属二维码放在网站上。客户扫码关注「答巢AI客服助手」，即可向你的团队咨询。", bullets: ["专属二维码入口，消息按商家路由", "客服在答巢工作台统一接待和回复", "关联多个商家时，由客户明确切换"] },
    { title: "自有公众号，独立经营", tag: "已有公众号，也能直接连接", text: "使用具备相应接口权限的自有公众号，按指引配置消息推送 URL、Token 和 EncodingAESKey，在安全配置流程中连接应用凭据。", bullets: ["保留自己的公众号品牌与入口", "会话、客户资料和团队备注集中管理", "公众号资质与微信相关费用需自行承担"] },
  ];
  return <section id="wechat-crm" className="mx-auto max-w-[1200px] scroll-mt-24 px-5 py-20 lg:px-8 lg:py-24"><p className="flex items-center gap-2 text-sm font-semibold text-emerald-700"><QrCode size={18}/>{en?'WeChat Official Account CRM':'微信公众号 CRM'}</p><h2 className="mt-4 max-w-3xl text-3xl font-semibold leading-tight tracking-tight text-[#071a3d] sm:text-4xl">{en?'Start talking to customers without certifying your own account.':'不必先认证自己的公众号，也能开始客户接待。'}</h2><p className="mt-5 max-w-3xl text-base leading-8 text-slate-600">{en?'Bring WeChat and website conversations into one workspace. Manage customer details, internal notes, ownership and replies with clear business boundaries.':'把微信咨询和网站聊天接入同一个工作台，集中管理客户资料、内部备注、会话负责人和回复，让一次咨询成为可持续跟进的客户关系。'}</p><div className="mt-9 grid gap-5 md:grid-cols-2">{cards.map((c,i)=><article key={c.title} className={`rounded-3xl border p-6 sm:p-8 ${i===0?'border-emerald-200 bg-emerald-50/50':'border-slate-200 bg-white'}`}><p className={`text-xs font-semibold ${i===0?'text-emerald-700':'text-blue-700'}`}>{c.tag}</p><h3 className="mt-3 text-xl font-semibold">{c.title}</h3><p className="mt-4 text-sm leading-7 text-slate-600">{c.text}</p><ul className="mt-5 space-y-3">{c.bullets.map(b=><li key={b} className="flex gap-2 text-sm text-slate-700"><ShieldCheck size={16} className="mt-0.5 shrink-0 text-emerald-600"/>{b}</li>)}</ul></article>)}</div><div className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 text-sm leading-7 text-slate-600"><p className="font-semibold text-slate-800">{en?'What “zero cost” means':'“0 成本”的范围说明'}</p><p>{en?'The shared channel avoids the need to certify your own official account; it does not mean all ReplyNest subscriptions or services are free. Shared access requires activation and is intended for initial use, with shared quotas and availability. Delivery remains subject to WeChat permissions, messaging windows and rate limits. Keep Web Chat as a fallback.':'指通过共享体验渠道免去自有公众号的认证成本，不代表答巢套餐或全部服务永久免费。共享渠道需申请开通，适用于起步体验，共享额度与可用性；消息发送受微信接口权限、回复窗口和频率限制。建议保留网站聊天作为备用入口。'}</p><a href={`https://docs.replynest.cn/${en?'en/':''}wechat-official/`} className="mt-2 inline-flex items-center gap-2 font-semibold text-blue-700 underline underline-offset-4">{en?'Read the setup guide':'查看微信公众号接入指南'}<ArrowRight size={16}/></a></div></section>;
}
