import {AdminListNavigation} from '../../../components/admin-list-navigation';
import {adminListQuery,type AdminListQuery,type AdminListResult} from '../../../lib/admin-list-query';
import { redirect } from 'next/navigation';
import { PlatformAdminShell } from '../../../components/platform-admin-shell';
import { fetchPlatformAdminSession } from '../../../lib/platform-admin-session';
import { platformAdminLoad } from '../../../lib/platform-admin-proxy';
export const dynamic='force-dynamic';
type Refund={refund_request_id:string;order_number:string;tenant_id:string;amount_minor:string;status:string;reason:string;requested_by:string;attempt_count:number;last_error_code:string|null;policy_quote?:{original_minor:number;fee_minor:number;usage_minor:number;used_days:number;total_days:number}};
const names:Record<string,string>={requested:'待管理员审批',approved:'已批准 · 等待执行',processing:'处理中',retry:'结果待确认 · 将重试查询',succeeded:'退款已确认',review:'需人工核对',rejected:'申请已驳回'};
export default async function RefundsPage({searchParams}:{searchParams:Promise<AdminListQuery>}){
  const session=await fetchPlatformAdminSession();if(!session)redirect('/internal-admin/login');
  if(!['owner','admin','auditor'].includes(session.user.role))redirect('/internal-admin');
  const params=await searchParams,filter=adminListQuery(params),result=await platformAdminLoad('records/refunds?'+filter.params) as AdminListResult<Refund>|undefined,rows=result?.items,canWrite=['owner','admin'].includes(session.user.role);
  return <PlatformAdminShell session={session} activePath="/internal-admin/payment-refunds">
    <h1 className="text-2xl font-semibold">支付宝退款审核</h1>
    <p className="text-sm text-slate-600">由管理员审核退款，可由同一管理员提交并批准。付款后 24 小时内扣 1% 平台手续费；24–168 小时扣已使用费用及 1% 手续费，不足一天按一天计；超过 168 小时不支持常规退款。批准不代表已退款，执行仍受独立开关控制；退款确认后撤销对应购买期的剩余权益。</p>
    {(params.saved||params.error)&&<p role="status" className="rounded-xl border bg-white p-3">{params.error?'操作未完成，请检查权限、订单状态、退款期限及套餐是否已开通。':'操作已记录，请以列表状态为准。'}</p>}
    {canWrite&&<form action="/api/platform-admin/payment-refunds" method="post" className="grid gap-3 rounded-2xl border bg-white p-5">
      <h2 className="font-semibold">申请套餐退款</h2><label className="text-sm">支付订单 ID<input name="payment_order_id" required pattern="[a-fA-F0-9-]{36}" placeholder="订单 UUID（不是支付宝交易号）" className="mt-1 block w-full rounded-lg border p-2"/></label>
      <label className="text-sm">退款原因<textarea name="reason" required minLength={10} maxLength={256} className="mt-1 block w-full rounded-lg border p-2"/></label><p className="text-xs text-slate-500">退款按实付金额及套餐周期自动计算，扣费四舍五入到分，计算结果在提交时固定；仅提交申请，不立即出款。</p><button className="justify-self-start rounded-lg bg-blue-600 px-4 py-2 text-white">提交退款申请</button>
    </form>}
    <AdminListNavigation path="/internal-admin/payment-refunds" q={filter.q} page={filter.page} status={filter.status} hasMore={!!result?.has_more} states={names} placeholder="搜索企业、租户 ID、申请编号或订单号"/><section className="space-y-3">{!rows?<p>退款数据暂不可用，请稍后刷新。</p>:rows.length===0?<p>暂无退款申请。</p>:rows.map(r=><article key={r.refund_request_id} className="rounded-xl border bg-white p-4">
      <div className="flex flex-wrap justify-between gap-2"><b>{r.order_number}</b><span>¥{(Number(r.amount_minor)/100).toFixed(2)} · {names[r.status]??r.status}</span></div><p className="mt-2 text-sm">{r.reason}</p><p className="mt-2 text-xs text-slate-500">企业 {r.tenant_id} · 尝试 {r.attempt_count} 次{r.last_error_code&&` · ${r.last_error_code}`}</p>
      {r.policy_quote&&<p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">实付 ¥{(r.policy_quote.original_minor/100).toFixed(2)} − 使用费 ¥{(r.policy_quote.usage_minor/100).toFixed(2)}（{r.policy_quote.used_days}/{r.policy_quote.total_days} 天，24 小时内免使用费）− 手续费 ¥{(r.policy_quote.fee_minor/100).toFixed(2)} = 应退 ¥{(Number(r.amount_minor)/100).toFixed(2)}</p>}{canWrite&&r.status==='requested'&&<form method="post" className="mt-3 flex flex-wrap gap-2"><input name="reason" required minLength={10} maxLength={256} placeholder="审核意见（至少10字）" className="min-w-0 flex-1 rounded-lg border p-2"/><button formAction={`/api/platform-admin/payment-refunds/${r.refund_request_id}/approve`} className="rounded-lg bg-amber-600 px-3 text-white disabled:opacity-40">批准退款</button><button formAction={`/api/platform-admin/payment-refunds/${r.refund_request_id}/reject`} className="rounded-lg border px-3">驳回申请</button></form>}
    </article>)}</section>
  </PlatformAdminShell>;
}
