import { redirect } from 'next/navigation';
import { ConsoleAccessDenied } from '../../../components/console-access-denied';
import { canViewBillingHistory } from '../../../lib/console-access';
import { ConsolePageHeading } from '../../../components/console-page-heading';
import { ConsoleShell } from '../../../components/console-shell';
import { BillingHistoryLinks, billingHistoryViews } from '../../../components/billing-history-links';
import { WalletPanel } from '../../../components/wallet-panel';
import { AiPointsBalance } from '../../../components/ai-points-balance';
import { AutomaticReceptionRecords } from '../../../components/automatic-reception-management';
import { CustomerInsightsBilling } from '../../../components/customer-insights-billing';
import { TemplateMarketPayouts } from '../../../components/template-market-payouts';
import { fetchConsoleSession, sessionToken, gatewayUrl } from '../../../lib/console-session';
import { formatMinor, type PaymentOrder, type BillingTransaction } from '../../../lib/billing';
import { fetchReferrals } from '../../../lib/referrals';
export const dynamic='force-dynamic';
const card='mt-6 rounded-2xl border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)]';
const states:Record<string,string>={pending_payment:'待付款',paid:'已支付',partially_refunded:'部分退款',refunded:'已退款',chargeback:'已拒付',cancelled:'已取消'};

export default async function BillingHistoryPage({searchParams}:{searchParams:Promise<{view?:string;page?:string}>}){
 const session=await fetchConsoleSession(),token=await sessionToken();
 if(!session||!token)redirect('/login?error=expired');
 const workspace=session.workspaces.find(w=>w.tenant_id===session.selected_tenant_id);
 if(!workspace)redirect('/workspaces');if(workspace.role==='agent')return <ConsoleAccessDenied session={session} workspace={workspace} activePath="/billing"/>;
 const query=await searchParams,view=query.view??'',rawPage=Number(query.page??1),page=Number.isSafeInteger(rawPage)?Math.min(10000,Math.max(1,rawPage)):1;
 if(!canViewBillingHistory(view,workspace.role,Boolean(session.impersonation)))return <ConsoleAccessDenied session={session} workspace={workspace} activePath="/billing"/>;
 const canWrite=workspace.role==='tenant_admin'&&!session.impersonation;
 const insights=process.env.CONSOLE_CUSTOMER_INSIGHTS_ENABLED==='true'&&canWrite;
 const reception=canWrite,title=billingHistoryViews.find(([key])=>key===view)?.[1];
 let orders:PaymentOrder[]|undefined,ledger:BillingTransaction[]|undefined,commissions:Awaited<ReturnType<typeof fetchReferrals>>;
 let failed=false,hasNext=false;
 // Fetch only the explicitly selected history. Plain links do not prefetch records.
 try{
  if(view==='orders'||view==='ledger'){
   const response=await fetch(gatewayUrl(view==='orders'?`/api/v1/billing/payment-orders?limit=10&page=${page}`:`/api/v1/billing/ledger?limit=10&offset=${(page-1)*10}`),{headers:{authorization:`Bearer ${token}`},cache:'no-store',signal:AbortSignal.timeout(8000)});
   if(!response.ok)throw Error();const result=await response.json();hasNext=Boolean(result.pagination?.has_next);
   if(view==='orders')orders=result.data;else ledger=result.data;
  }else if(view==='commissions'){
   commissions=await fetchReferrals(token,true);if(!commissions)throw Error();
   hasNext=(commissions.commissions?.length??0)>page*10;
  }
 }catch{failed=true;}
 return <ConsoleShell session={session} workspace={workspace} activePath="/billing" statusPageUrl={process.env.STATUS_PUBLIC_URL??'http://localhost:3300'}><main className="mx-auto min-h-screen max-w-6xl p-4 md:p-8">
  <ConsolePageHeading icon="billing">账务明细{title?' · '+title:''}</ConsolePageHeading>
  <a href="/billing" className="mt-3 inline-block text-sm text-blue-700 underline">返回套餐与账务</a>
  <BillingHistoryLinks reception={reception} insights={insights}/>
  {!title&&<p className={card}>请选择需要查看的记录类别。</p>}
  {view==='reception'&&(reception?<AutomaticReceptionRecords key={workspace.tenant_id} workspaceId={workspace.tenant_id}/>:<p role="alert" className={card}>仅企业管理员本人可查看自动接待执行记录。</p>)}
  {view==='insights'&&(insights?<CustomerInsightsBilling key={workspace.tenant_id} workspaceId={workspace.tenant_id}/>:<p role="alert" className={card}>客户 AI 备注与画像尚未开放。</p>)}
  {['purchases','refunds','withdrawals'].includes(view)&&<WalletPanel key={workspace.tenant_id+view} history={view==='purchases'?'purchases':'requests'} referral={view==='withdrawals'} canWrite={canWrite}/>}
  {view==='points'&&<section className={card}><AiPointsBalance key={workspace.tenant_id} history canWrite={canWrite}/></section>}
  {view==='template-payouts'&&<TemplateMarketPayouts key={workspace.tenant_id}/>}
  {failed&&<p role="alert" className={card}>记录暂不可用，请刷新重试；不代表没有记录。</p>}
  {!failed&&orders&&<section className={card}><h2 className="font-semibold">充值与支付宝订单</h2>{!orders.length&&<p className="mt-3 text-sm text-slate-500">暂无订单。</p>}{orders.map(o=><article key={o.payment_order_id} className="mt-4 flex flex-wrap justify-between gap-3 border-t pt-4 text-sm"><div><b>{o.product_code==='wallet.topup.v2'?'现金充值':'历史支付宝订单'} · {o.order_number}</b><p className="mt-1 text-slate-500">{new Date(o.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · {states[o.status]??o.status}{o.status==='paid'&&o.product_code==='wallet.topup.v2'&&(o.projected_count>0?' · 已入账':' · 正在入账')}</p>{o.fulfillment&&<p className="mt-1 text-slate-500">{o.refund_request?.status==='succeeded'?'历史套餐已退款':o.fulfillment.status==='fulfilled'?'历史套餐权益已开通':'权益处理中或需核对'}；历史订单按原规则处理，请联系客服。</p>}</div><span>{formatMinor(o.amount_minor,o.currency)}{Number(o.refunded_minor)>0&&` · 已退 ${formatMinor(o.refunded_minor,o.currency)}`}</span></article>)}</section>}
  {!failed&&ledger&&<section className={card}><h2 className="font-semibold">账户流水</h2>{!ledger.length&&<p className="mt-3 text-sm text-slate-500">暂无流水。</p>}{ledger.map(t=><div key={t.transaction_id} className="mt-3 flex flex-wrap justify-between gap-3 border-t pt-3 text-sm"><div>{({topup:'充值',charge:'消费',refund:'退款／支出',gift_grant:'赠送',ai_credit_grant:'AI 额度',opening:'期初入账',reversal:'冲回'} as Record<string,string>)[t.transaction_type]??'账务变动'}<span className="ml-2 text-xs text-slate-500">{new Date(t.posted_at).toLocaleString()}</span></div><span>{formatMinor(t.tenant_balance_delta_minor,t.currency)}</span></div>)}</section>}
  {!failed&&view==='commissions'&&<section className={card}><h2 className="font-semibold">返佣明细</h2><p className="mt-2 text-xs text-slate-500">最近 100 条，每页 10 条。</p>{!commissions?.commissions?.length&&<p className="mt-3 text-sm text-slate-500">暂无返佣记录。</p>}{commissions?.commissions?.slice((page-1)*10,page*10).map(c=><p key={c.commission_id} className="mt-3 border-t pt-3 text-sm">{c.payment_kind==='first'?'首笔':'续费／后续'} · ¥{(Number(c.cash_minor)/100).toFixed(2)} × {c.rate_bps/100}% · ¥{(Number(c.retained_minor??c.amount_minor)/100).toFixed(2)} · {({pending:'观察中',review:'风险复核中',posted:'已结算',rejected:'不予结算'} as Record<string,string>)[c.status]??'待核对'}</p>)}</section>}
  {!failed&&['orders','ledger','commissions'].includes(view)&&<nav className="mt-4 flex items-center gap-4 text-sm" aria-label="账务记录分页">{page>1&&<a href={`/billing/history?view=${view}&page=${page-1}`} className="text-blue-700 underline">上一页</a>}<span>第 {page} 页</span>{hasNext&&<a href={`/billing/history?view=${view}&page=${page+1}`} className="text-blue-700 underline">下一页</a>}</nav>}
 </main></ConsoleShell>;
}
