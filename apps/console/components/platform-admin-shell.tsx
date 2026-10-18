import Link from "next/link";
import { Activity, FileLock2, FlaskConical, House, Layers3, LogOut, RadioTower, Scale, Send, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { BrandLogo } from "./brand-logo";
import type { PlatformAdminSession } from "../lib/platform-admin-session";

const links = [
  {href:"/internal-admin/template-market",label:"模板市场审核",icon:Layers3,roles:["owner","admin"]},
  {href:"/internal-admin/growth-policy",label:"试用、赠金与返佣",icon:Layers3,roles:["owner","admin","auditor"]},
  {href:"/internal-admin/ai-points",label:"AI 点数与成本",icon:Activity,roles:["owner","admin","auditor"]},
  { href: "/internal-admin", label: "运营总览", icon: House, roles: ["owner", "admin", "support", "auditor"] },
  { href: "/internal-admin/registration", label: "注册风控", icon: Activity, roles: ["owner", "admin", "support", "auditor"] },
  { href: "/internal-admin/pilot", label: "试运营", icon: FlaskConical, roles: ["owner", "admin", "support", "auditor"] },
  { href: "/internal-admin/campaigns", label: "活动诊断", icon: Send, roles: ["owner", "admin", "support", "auditor"] },
  { href: "/internal-admin/privacy", label: "隐私请求", icon: FileLock2, roles: ["owner", "admin", "support", "auditor"] },
  { href: "/internal-admin/subscriptions", label: "套餐权益", icon: Layers3, roles: ["owner", "admin"] },
  { href: "/internal-admin/plan-pricing", label: "套餐定价", icon: Layers3, roles: ["owner", "admin"] },
  { href: "/internal-admin/reconciliation", label: "支付对账", icon: Scale, roles: ["owner", "admin", "auditor"] },
  { href: "/internal-admin/payment-refunds", label: "退款审核", icon: Scale, roles: ["owner", "admin", "auditor"] },
  { href: "/internal-admin/wallet-requests", label: "余额与提现审批", icon: Scale, roles: ["owner", "admin", "auditor"] },
  { href: "/internal-admin/monitoring", label: "状态告警", icon: RadioTower, roles: ["owner", "admin", "support", "auditor"] },
  { href: "/internal-admin/security", label: "安全中心", icon: ShieldCheck, roles: ["owner", "admin", "support", "auditor"] },
] as const;
const groups=[
 {name:'运营管理',paths:['/internal-admin','/internal-admin/pilot','/internal-admin/campaigns']},
 {name:'产品与增长',paths:['/internal-admin/growth-policy','/internal-admin/subscriptions','/internal-admin/plan-pricing','/internal-admin/ai-points','/internal-admin/template-market']},
 {name:'财务管理',paths:['/internal-admin/reconciliation','/internal-admin/payment-refunds','/internal-admin/wallet-requests']},
 {name:'安全与运维',paths:['/internal-admin/registration','/internal-admin/privacy','/internal-admin/monitoring','/internal-admin/security']},
];

export function PlatformAdminShell({ session, activePath, children }: { session: PlatformAdminSession; activePath: string; children: ReactNode }) {
  const visible=links.filter(item=>(item.roles as readonly string[]).includes(session.user.role));
  const availableGroups=groups.map(group=>({...group,items:group.paths.flatMap(path=>visible.filter(item=>item.href===path))})).filter(group=>group.items.length);
  const selected=availableGroups.find(group=>group.paths.includes(activePath))??availableGroups[0];
  return <main className="min-h-screen bg-slate-100 text-slate-900">
    <header className="sticky top-0 z-30 border-b bg-white/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1500px] items-center justify-between gap-4 px-4 md:px-8">
        <div className="flex min-w-0 items-center gap-3"><BrandLogo className="h-9 w-[158px] shrink-0"/><span className="hidden rounded-full bg-slate-900 px-3 py-1 text-xs text-white sm:inline">内部管理</span></div>
        <div className="flex items-center gap-2 text-sm"><span className="hidden max-w-56 truncate text-slate-600 md:inline">{session.user.display_name} · {session.user.role}</span><form action="/api/platform-admin/logout" method="post"><button className="flex items-center gap-1 rounded-lg border px-3 py-2 hover:bg-slate-50"><LogOut size={15}/>退出</button></form></div>
      </div>
      <nav aria-label="平台管理导航" className="mx-auto flex max-w-[1500px] gap-1 overflow-x-auto px-4 pb-2 md:px-8">
        {availableGroups.map(group=><Link key={group.name} href={group.items[0].href} aria-current={selected?.name===group.name?'true':undefined} className={`shrink-0 rounded-lg px-3 py-2 text-sm font-semibold ${selected?.name===group.name?'bg-blue-50 text-blue-700':'text-slate-600 hover:bg-slate-50'}`}>{group.name}</Link>)}
      </nav>
      <nav aria-label="当前分类子菜单" className="mx-auto flex max-w-[1500px] flex-wrap gap-1 border-t px-4 py-2 md:px-8">{selected?.items.map(item=>{const Icon=item.icon;return <Link key={item.href} href={item.href} aria-current={activePath===item.href?'page':undefined} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm ${activePath===item.href?'bg-slate-900 text-white':'text-slate-600 hover:bg-slate-50'}`}><Icon size={15}/>{item.label}</Link>;})}</nav>
    </header>
    <div className="mx-auto max-w-[1500px] space-y-6 p-4 pb-8 md:p-8">{children}</div>
  </main>;
}
