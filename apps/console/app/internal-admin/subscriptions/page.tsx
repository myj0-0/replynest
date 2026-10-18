import { BadgeCheck, Clock3, Layers3, ShieldCheck, XCircle } from "lucide-react";
import { redirect } from "next/navigation";
import { PlatformAdminShell } from "../../../components/platform-admin-shell";
import { fetchPlatformAdminSession } from "../../../lib/platform-admin-session";
import { platformAdminLoad } from "../../../lib/platform-admin-proxy";
import { AdminTenantPicker } from "../../../components/admin-tenant-picker";
import {AdminListNavigation} from '../../../components/admin-list-navigation';
import {adminListQuery,type AdminListQuery} from '../../../lib/admin-list-query';
type MailStatus={counts:{status:string;count:number}[];waiting:number;issues:{delivery_id:string;status:string;tenant_name:string;kind:string;attempts:number;error_code:string;updated_at:string}[]};
type Entitlements = { seat_limit: number | null; channel_limit: number | null; customer_limit: number | null; ai_actions_monthly: number | null; knowledge_bytes: number | null; automation_rule_limit: number | null; qr_code_limit: number | null; audit_retention_days: number | null };
type Plan = { plan_code: string; name: string; version: number; price_minor: string | null; currency: string; entitlement_rules: Entitlements };
type Change = { change_request_id: string; tenant_id: string; tenant_name: string; status: string; request_reason: string; approval_reason?: string; requested_by: string; requested_by_name: string; approved_by?: string; approved_by_name?: string; plan_code: string; target_plan_name: string; version: number; requested_price_minor: string | null; requested_currency: string; requested_entitlement_snapshot?: Entitlements & {manual_validity?:{days:number|null}}; executed_period_end?:string|null; approval_mode: "single" | "dual"; created_at: string };

const value = (item: number | null) => item === null ? "不限" : item.toLocaleString("zh-CN");
const money = (minor: string | null) => minor === null ? "面议" : `¥${(Number(minor) / 100).toFixed(2)}`;

export default async function SubscriptionAdminPage({ searchParams }: { searchParams: Promise<AdminListQuery> }) {
  const session = await fetchPlatformAdminSession();
  if (!session) redirect("/internal-admin/login");
  if (!["owner", "admin"].includes(session.user.role)) redirect("/internal-admin");
  const query = await searchParams;
  const filter=adminListQuery(query);
  const data = await platformAdminLoad("subscription-changes?"+filter.params) as { requests: Change[]; plans: Plan[]; approval_mode: "single" | "dual";has_more:boolean } | undefined;
  const mail=await platformAdminLoad('subscription-mail') as MailStatus|undefined;
  const requests = data?.requests ?? [], plans = data?.plans ?? [], approvalMode = data?.approval_mode ?? "dual";
  const single = approvalMode === "single";

  return <PlatformAdminShell session={session} activePath="/internal-admin/subscriptions">
    <div><h1 className="flex items-center gap-2 text-2xl font-semibold"><Layers3/>租户套餐与权益调整</h1><p className="mt-1 text-sm text-slate-500">以目录套餐为基线，为指定租户生成新的价格和权益快照；历史套餐、历史订阅与审计记录不会被覆盖。</p></div>
    <div className={`rounded-2xl border p-4 text-sm ${single ? "border-blue-200 bg-blue-50 text-blue-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}><div className="flex items-start gap-2"><ShieldCheck className="mt-0.5 shrink-0" size={18}/><div><b>{single ? "当前为单管理员执行模式" : "当前为双人审批模式"}</b><p className="mt-1">{single ? "提交后立即执行，并记录操作者、原因、调整前后快照和请求编号。以后增加管理员后可通过配置切回双人审批。" : "申请人与审批人必须不同，批准后才会切换订阅。"}</p></div></div></div>
    {(query.saved || query.error) && <p className={`rounded-xl p-3 text-sm ${query.error ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>{query.error ? "操作未执行；请检查当前订阅、输入范围或并发调整状态。" : single ? "套餐与权益快照已立即生效。" : "申请已提交。"}</p>}

    <section className="rounded-2xl border bg-white p-5"><h2 className="font-semibold">调整租户套餐</h2><p className="mt-1 text-xs leading-5 text-slate-500">自定义字段留空时沿用所选目录套餐。价格单位为人民币元，知识库单位为 MB；0 表示额度为 0，并不表示不限。</p>
      <form action="/api/platform-admin/subscriptions/change-requests" method="post" className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <AdminTenantPicker/>
        <label className="text-xs text-slate-600 md:col-span-2">目录套餐<select name="target_plan_code" required className="mt-1 w-full rounded-xl border p-3 text-sm"><option value="">选择基线套餐</option>{plans.map(p => <option key={p.plan_code} value={p.plan_code}>{p.name} V{p.version} · {money(p.price_minor)} · {value(p.entitlement_rules.seat_limit)}坐席 / {value(p.entitlement_rules.ai_actions_monthly===null?null:p.entitlement_rules.ai_actions_monthly*10)} AI点</option>)}</select></label>
        <Field name="price_yuan" label="租户价格（元）" step="0.01"/>
        <Field name="seat_limit" label="座席数"/>
        <Field name="ai_points_monthly" label="AI 点数/月（10 的倍数）" step="10"/>
        <Field name="channel_limit" label="渠道数"/>
        <Field name="customer_limit" label="客户数"/>
        <Field name="knowledge_mb" label="知识库（MB）"/>
        <Field name="automation_rule_limit" label="自动化规则数"/>
        <Field name="qr_code_limit" label="二维码数"/>
        <Field name="audit_retention_days" label="审计保留天数"/>
        <label className="text-xs text-slate-600">服务期限<select name="validity_mode" defaultValue="days" className="mt-1 w-full rounded-xl border p-3 text-sm"><option value="days">限期有效（到期恢复免费版）</option><option value="unlimited">长期有效（明确授予）</option></select></label>
        <label className="text-xs text-slate-600">有效天数<input type="number" name="validity_days" min="1" max="3650" step="1" defaultValue="30" required className="mt-1 w-full rounded-xl border p-3 text-sm"/></label>
        <p className="self-center text-xs leading-5 text-slate-500 md:col-span-2">限期从实际执行时起算，审批等待时间不扣天数；长期有效时忽略天数。到期后按免费版权益限制新增使用，不删除原有客户、知识和聊天记录。人工调整不扣款，也不重置本月已用 AI 点数。</p>
        <label className="text-xs text-slate-600 md:col-span-2 lg:col-span-3">调整原因<input name="reason" minLength={10} maxLength={500} required placeholder="说明商务约定或人工调整原因（至少 10 字）" className="mt-1 w-full rounded-xl border p-3 text-sm"/></label>
        <button className="self-end rounded-xl bg-slate-950 p-3 text-sm font-semibold text-white">{single ? "确认并立即执行" : "提交审批申请"}</button>
      </form>
    </section>

    <section className="rounded-2xl border bg-white p-5"><h2 className="font-semibold">套餐与 AI 点数邮件通知</h2><p className="mt-2 text-sm text-slate-500">购买成功（含续费）；付费及人工调整的非免费限期套餐到期前 3 天，通知企业管理员已验证邮箱。每分钟检查；续费或调整后重新核对期限；免费版、试用、长期授权无套餐到期提醒。人工调整、免费版、试用和充值不触发购买成功邮件。</p><p className="mt-2 text-sm text-slate-500">AI 点数：按本周期套餐点数与仍有效的额外授予额度合计，剩余不足 10% 时提醒。后台分批轮转检查；同一低余额状态仅提醒一次，恢复后再次跌破才提醒，至少间隔 24 小时。发送前重新核验余额及邮箱权限。</p>{mail?<><p className="mt-3 text-sm">套餐邮件计数 · 待准备：{mail.waiting} · {mail.counts.map(c=>`${({pending:'待发送',sending:'发送中',sent:'邮件服务已接收',retry:'等待重试',review:'待核查',canceled:'已取消'} as Record<string,string>)[c.status]}：${c.count}`).join(' · ')}</p><p className="mt-2 text-xs text-slate-500">以下展示套餐及点数邮件最近 20 条重试／待核查记录。</p>{mail.issues.map(issue=><p key={issue.delivery_id} className="mt-2 break-all text-xs text-amber-800">{issue.tenant_name} · {issue.kind==='ai_points_low'?'AI 点数不足':issue.kind==='purchased'?'购买成功':'到期提醒'} · {issue.status==='review'?'发送结果需核查，不自动重发':'已明确拒绝，等待重试'} · 已尝试 {issue.attempts} 次 · 编号 {issue.delivery_id}</p>)}</>:<p className="mt-3 text-sm text-amber-700">通知状态暂时无法读取。</p>}<p className="mt-2 text-xs text-slate-500">邮件服务接收不代表用户已阅读。没有有效管理员邮箱时等待验证；发送结果不明确时保留待核查记录，避免重复通知。</p></section>
    <section className="rounded-2xl border bg-white p-5"><h2 className="font-semibold">调整记录</h2><AdminListNavigation path="/internal-admin/subscriptions" q={filter.q} status={filter.status} page={filter.page} hasMore={!!data?.has_more} states={{pending_approval:'待审批',executed:'已执行',rejected:'已驳回'}} placeholder="搜索企业名称、租户 ID 或申请编号"/>{!data&&<p role="alert">调整记录加载失败，请重试。</p>}<div className="mt-4 space-y-3">{requests.map(item => <article key={item.change_request_id} className="rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><div><b>{item.tenant_name}</b> → {item.target_plan_name} V{item.version}</div><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${item.status === "executed" ? "bg-green-50 text-green-700" : item.status === "rejected" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>{item.status === "executed" ? "已执行" : item.status === "rejected" ? "已驳回" : "待审批"}</span></div>
      <p className="mt-2 text-sm text-slate-600">操作者：{item.requested_by_name} · {item.request_reason}</p>
      <p className="mt-2 text-sm font-semibold text-blue-700">服务期限：{item.status==='executed' ? item.executed_period_end ? `到期于 ${new Date(item.executed_period_end).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}（北京时间）` : '长期有效' : item.requested_entitlement_snapshot?.manual_validity?.days ? `执行后 ${item.requested_entitlement_snapshot.manual_validity.days} 天` : '长期有效'}</p>
      {item.requested_entitlement_snapshot && <p className="mt-1 text-xs leading-5 text-slate-500">{money(item.requested_price_minor)} · {value(item.requested_entitlement_snapshot.seat_limit)} 坐席 · {value(item.requested_entitlement_snapshot.ai_actions_monthly===null?null:item.requested_entitlement_snapshot.ai_actions_monthly*10)} AI点数/月 · {value(item.requested_entitlement_snapshot.channel_limit)} 渠道 · {Math.round(Number(item.requested_entitlement_snapshot.knowledge_bytes ?? 0) / 1048576).toLocaleString("zh-CN")} MB知识库</p>}
      {item.approved_by_name && item.approval_mode === "dual" && <p className="mt-1 text-sm text-slate-600">审批人：{item.approved_by_name} · {item.approval_reason}</p>}
      <p className="mt-2 flex items-center gap-1 text-xs text-slate-400"><Clock3 size={13}/>{new Date(item.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} · {item.approval_mode === "single" ? "单管理员执行" : "双人审批"}</p>
      {item.status === "pending_approval" && (single || item.requested_by !== session.user.admin_id) && <div className="mt-3 grid gap-2 sm:grid-cols-2"><form action={`/api/platform-admin/subscriptions/change-requests/${item.change_request_id}/approve`} method="post" className="flex gap-2"><input name="reason" required minLength={10} placeholder="执行意见（至少 10 字）" className="min-w-0 flex-1 rounded-lg border p-2"/><button title="批准并执行" className="rounded-lg bg-green-600 px-3 text-white"><BadgeCheck/></button></form><form action={`/api/platform-admin/subscriptions/change-requests/${item.change_request_id}/reject`} method="post" className="flex gap-2"><input name="reason" required minLength={10} placeholder="驳回原因（至少 10 字）" className="min-w-0 flex-1 rounded-lg border p-2"/><button title="驳回" className="rounded-lg bg-red-600 px-3 text-white"><XCircle/></button></form></div>}
      {item.status === "pending_approval" && !single && item.requested_by === session.user.admin_id && <p className="mt-3 flex items-center gap-2 text-xs text-amber-700"><ShieldCheck size={15}/>等待另一位 Owner 或管理员处理。</p>}
    </article>)}{!requests.length && <p className="text-sm text-slate-500">暂无套餐调整记录。</p>}</div></section>
  </PlatformAdminShell>;
}

function Field({ name, label, step = "1" }: { name: string; label: string; step?: string }) {
  return <label className="text-xs text-slate-600">{label}<input type="number" name={name} min="0" step={step} placeholder="沿用基线" className="mt-1 w-full rounded-xl border p-3 text-sm"/></label>;
}
