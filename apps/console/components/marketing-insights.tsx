import { FileSearch, History, PieChart, ShieldCheck } from 'lucide-react';

export function MarketingInsights({en=false}:{en?:boolean}){
 const items=en?[
  ['Remember customer needs','Incrementally organize stated needs across conversations, alongside a short summary of the current issue.'],
  ['Find the context quickly','Search AI notes in the support workspace. Agents can correct or delete AI results without overwriting manual notes.'],
  ['See what customers ask','Home dashboard charts summarize recent topics, stated needs and service preferences from saved results.'],
 ]:[
  ['长期备注，接续服务','按聊天事件增量整理客户明确表达的需求，跨会话累计长期备注，同时保留当前会话的问题摘要。'],
  ['交接与搜索，不再翻半天','在客服工作台搜索人工或 AI 备注，快速了解咨询背景。客服可纠正、删除 AI 结果，人工备注不会被覆盖。'],
  ['近期问题，一眼看清','控制台首页用饼图展示近期咨询主题、明确需求与服务偏好，帮助团队了解客户在问什么。'],
 ];
 return <section id="customer-insights" className="scroll-mt-24 bg-blue-50/50 py-20 lg:py-24"><div className="mx-auto max-w-[1200px] px-5 lg:px-8"><p className="text-sm font-semibold text-blue-700">{en?'AI notes · Customer insights':'AI 客户备注 · 用户画像'}</p><h2 className="mt-4 max-w-3xl text-3xl font-semibold leading-tight text-[#071a3d] sm:text-4xl">{en?'Remember the need. Understand the next conversation.':'不止回答这一次，也记住客户在意什么。'}</h2><p className="mt-5 max-w-3xl text-base leading-8 text-slate-600">{en?'Turn authorized conversation context into team-only notes and useful aggregates, not assumptions about sensitive identities.':'把已授权的聊天内容整理成团队可见的服务线索：客户需要什么、当前卡在哪里、希望怎样沟通。不推断敏感身份，不把 AI 总结当作确定事实。'}</p><div className="mt-10 grid gap-5 md:grid-cols-3">{items.map(([title,text],i)=>{const Icon=[History,FileSearch,PieChart][i];return <article key={title} className="rounded-3xl border border-blue-100 bg-white p-6"><Icon size={26} className="text-blue-600"/><h3 className="mt-5 text-lg font-semibold text-[#071a3d]">{title}</h3><p className="mt-3 text-sm leading-7 text-slate-600">{text}</p></article>;})}</div><div className="mt-6 flex items-start gap-3 rounded-2xl border border-blue-100 bg-white/80 p-5"><ShieldCheck className="mt-1 shrink-0 text-blue-600" size={20}/><p className="text-sm leading-7 text-slate-600">{en?'Disabled by default. Administrators separately authorize this purpose and set a daily AI-points budget. Generation consumes AI points; viewing saved charts does not call the model again or charge additional points. Multi-label needs and preferences use shares of category assignments, not exclusive shares of customers.':'默认关闭，由企业管理员单独授权并设置每日 AI 点数预算。生成备注与画像消耗 AI 点数；查看已生成结果和首页图表不再次调用模型扣点。需求与偏好可多选，图表按分类次数占比展示，不等同于互斥的客户人数占比。'}</p></div></div></section>;
}
