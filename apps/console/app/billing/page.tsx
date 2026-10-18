import { ConsolePageHeading } from '../../components/console-page-heading';
import { redirect } from 'next/navigation';
import { ConsoleAccessDenied } from '../../components/console-access-denied';
import { canManageConsoleFunds } from '../../lib/console-access';
import { fetchBilling } from '../../lib/billing';
import { fetchConsoleSession,sessionToken } from '../../lib/console-session';
import { fetchTrial } from '../../lib/trial';
import { ConsoleShell } from '../../components/console-shell';
import { getConsoleLocale } from '../../lib/console-locale-server';
import { WalletPanel } from '../../components/wallet-panel';
import { BillingHistoryLinks } from '../../components/billing-history-links';
import { SubscriptionExpiry } from '../../components/subscription-expiry';
export const dynamic='force-dynamic';
const card='mt-6 rounded-2xl border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)] md:p-6';
export default async function BillingPage({searchParams}:{searchParams:Promise<{trial?:string}>}){
 const session=await fetchConsoleSession(),token=await sessionToken(),en=(await getConsoleLocale())==='en';
 if(!session||!token)redirect('/login?error=expired');const workspace=session.workspaces.find(w=>w.tenant_id===session.selected_tenant_id);if(!workspace)redirect('/workspaces');if(workspace.role==='agent')return <ConsoleAccessDenied session={session} workspace={workspace} activePath="/billing"/>;
 const canWrite=canManageConsoleFunds(workspace.role, Boolean(session.impersonation));
 const [billing,trial,query]=await Promise.all([fetchBilling(token),fetchTrial(token),searchParams]);
 return <ConsoleShell session={session} workspace={workspace} activePath="/billing" statusPageUrl={process.env.STATUS_PUBLIC_URL??'http://localhost:3300'}><main className="mx-auto min-h-screen max-w-6xl p-4 md:p-8">
 <ConsolePageHeading icon="billing">{en?'Plans & billing':'套餐与账务'}</ConsolePageHeading><p className="mt-2 text-sm leading-6 text-slate-500">{en?'Top up your account, then choose a plan. Gift balance is used before cash. No automatic renewal.':'先充值，再选择套餐。优先使用赠送余额，不足再扣现金；单次购买，不自动续费。'}</p>
 <details className="mt-2 text-sm leading-6 text-slate-500"><summary className="cursor-pointer text-blue-700">{en?'Plan term & point renewal rules':'套餐期限与点数更新规则'}</summary> <p className="mt-2 text-sm leading-6 text-slate-500">{en?'Monthly: 1 calendar month. Annual: 12 calendar months for 8 monthly fees. Points refresh monthly from activation, not on the first of each month or immediately on renewal.':'月付为 1 个自然月，年付为 12 个自然月（费用为月价的 8 倍），不是固定 30／360 天。套餐 AI 点数按生效日逐月更新，跨月及提前续费不额外补发。'} <a className="text-blue-600 underline" href="https://docs.replynest.cn/billing" target="_blank" rel="noreferrer">{en?'Billing rules':'查看详细计费规则'}</a></p></details>
 {!billing?<p role="alert" className={card}>套餐数据暂不可用，请稍后刷新。为避免错误扣款，暂不展示购买入口。</p>:<><section className={card}><p className="text-sm font-semibold text-blue-700">{en?'Current plan':'当前套餐'}</p><h2 className="mt-2 text-xl font-semibold">{billing.subscription.plan.name}</h2><SubscriptionExpiry end={billing.subscription.subscription.current_period_end} reset={billing.subscription.usage.period_end} free={billing.subscription.plan.code==='free'&&billing.subscription.source!=='trial'} en={en}/><p className="mt-3 text-xs text-slate-500">套餐价格调整不会追溯修改已购买权益。</p><div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5">{[
 ['坐席',billing.subscription.usage.active_seats,billing.subscription.entitlements.seat_limit],['渠道',billing.subscription.usage.channels,billing.subscription.entitlements.channel_limit],['客户',billing.subscription.usage.customers,billing.subscription.entitlements.customer_limit],...(billing.aiPoints?.enabled?[['本周期 AI 点数',billing.aiPoints.monthly_used_micros/1e6,billing.aiPoints.monthly_limit_micros===null?null:billing.aiPoints.monthly_limit_micros/1e6]]:[['本周期 AI 建议',Number(billing.subscription.usage.ai_actions_monthly),billing.subscription.entitlements.ai_actions_monthly]]),['知识库（MB）',Math.ceil(Number(billing.subscription.usage.knowledge_bytes)/1048576),billing.subscription.entitlements.knowledge_bytes===null?null:Math.ceil(billing.subscription.entitlements.knowledge_bytes/1048576)]
 ].map(([label,used,limit])=><div key={String(label)} className="rounded-xl bg-slate-50 p-4"><p className="text-xs text-slate-500">{label}</p><p className="mt-2 font-semibold">{Number(used).toLocaleString()} / {limit===null?'不限':Number(limit).toLocaleString()}</p></div>)}</div></section><WalletPanel plans={billing.plans} canWrite={canWrite} en={en}/></>}
 <section className={card}><h2 className="font-semibold">新企业免费试用</h2>{!trial?<p className="mt-2 text-sm">试用服务暂不可用。</p>:trial.entitlement?<p className="mt-2 text-sm">{({active:'试用中',expired:'已到期',converted:'已转付费',revoked:'已撤销',provisioning:'发放中'} as Record<string,string>)[trial.entitlement.status]??trial.entitlement.status} · {new Date(trial.entitlement.ends_at).toLocaleDateString()}</p>:trial.campaign?<><p className="mt-2 text-sm">{trial.campaign.name}，无需预绑支付方式。</p>{trial.eligibility?.outcome==='eligible'&&canWrite&&<form action="/api/trial/claim" method="post"><button className="mt-3 rounded-xl bg-blue-600 px-4 py-2 text-white">领取免费试用</button></form>}</>:<p className="mt-2 text-sm">暂无开放的试用活动。</p>}{query.trial&&<p role="status" className="mt-2 text-sm">{query.trial==='claimed'?'试用已领取。':'本次领取未完成，请检查资格或联系管理员。'}</p>}</section>
 <BillingHistoryLinks en={en} reception={canWrite} insights={process.env.CONSOLE_CUSTOMER_INSIGHTS_ENABLED==='true'&&canWrite}/>
 </main></ConsoleShell>;
}
