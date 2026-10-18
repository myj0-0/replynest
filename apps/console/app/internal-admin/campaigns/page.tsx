import {AdminListNavigation} from '../../../components/admin-list-navigation';
import {adminListQuery,type AdminListQuery} from '../../../lib/admin-list-query';
import { Activity, AlertTriangle, Clock3, Send } from "lucide-react";
import { redirect } from "next/navigation";
import { PlatformAdminShell } from "../../../components/platform-admin-shell";
import { platformAdminLoad } from "../../../lib/platform-admin-proxy";
import { fetchPlatformAdminSession } from "../../../lib/platform-admin-session";

export const dynamic = "force-dynamic";
type Mass={pending_batches:number;paused_batches:number;awaiting_receipt_batches:number;uncertain_batches:number;ready_batches:number;oldest_ready_seconds:number;oldest_receipt_seconds:number;succeeded_batches_24h:number;unsuccessful_batches_24h:number;failure_rate_percent:number};
type Row={tenant_id:string;name:string;campaigns_24h:number;active_campaigns:number;pending:number;oldest_pending_seconds:number;dead_24h:number;failure_rate_percent:number;mass:Mass};
type Thresholds={backlog:number;oldest_seconds:number;failure_rate_percent:number;failure_sample_minimum:number};
type Data={page:number;has_more:boolean;window:string;execution_enabled:boolean;monitor_enabled:boolean;thresholds:Thresholds;
 mass_monitor_enabled:boolean;mass_thresholds:Thresholds&{receipt_seconds:number;uncertain:number};mass_summary:Mass;monitor_batch_size:number;last_scan_at:string|null;
 summary:Row&{delivery_total_24h:number;delivered_24h:number;suppressed_24h:number};tenants:Row[]};
const duration=(seconds:number)=>seconds<60?`${seconds} 秒`:seconds<3600?`${Math.floor(seconds/60)} 分钟`:`${Math.floor(seconds/3600)} 小时 ${Math.floor(seconds%3600/60)} 分钟`;

export default async function CampaignDiagnosticsPage({searchParams}:{searchParams:Promise<AdminListQuery>}){
  const session=await fetchPlatformAdminSession();if(!session)redirect("/internal-admin/login");
  const filter=adminListQuery(await searchParams),data=await platformAdminLoad("campaigns?"+filter.params) as Data|undefined;if(!data)redirect("/internal-admin");
  const s=data.summary,m=data.mass_summary,cards=[{label:'到期可处理',value:`${m.ready_batches} 批`,icon:Send},{label:'已暂停',value:`${m.paused_batches} 批`,icon:Clock3},
   {label:'等待微信结果',value:`${m.awaiting_receipt_batches} 批`,icon:Clock3},{label:'结果不确定',value:`${m.uncertain_batches} 批`,icon:AlertTriangle},
   {label:'24小时平台确认成功',value:`${m.succeeded_batches_24h} 批`,icon:Activity},{label:'24小时受阻／失败／删除',value:`${m.unsuccessful_batches_24h} 批`,icon:AlertTriangle},
   {label:'最长到期等待',value:duration(m.oldest_ready_seconds),icon:Clock3},{label:'最长平台结果等待',value:duration(m.oldest_receipt_seconds),icon:Clock3}];
  return <PlatformAdminShell session={session} activePath="/internal-admin/campaigns">
    <section><h1 className="text-2xl font-semibold">消息活动诊断</h1><p className="mt-1 text-sm text-slate-500">跨租户只读视图；仅展示队列和投递聚合，不展示客户身份或消息正文。</p></section>
    <section className={`rounded-2xl border p-4 text-sm ${data.mass_monitor_enabled?"border-emerald-200 bg-emerald-50 text-emerald-800":"border-amber-200 bg-amber-50 text-amber-900"}`}>
     <p>总执行开关：{data.execution_enabled?'开启':'关闭'} · 公众号群发监控：{data.mass_monitor_enabled?'开启':'关闭'} · 每轮最多检查 {data.monitor_batch_size} 个企业，重启保留轮询进度。最近完成巡检：{data.last_scan_at?new Date(data.last_scan_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'尚未巡检'}（北京时间）。</p>
     <p className="mt-2">告警阈值：到期积压 {data.mass_thresholds.backlog} 批 / 到期等待 {duration(data.mass_thresholds.oldest_seconds)} / 平台结果等待 {duration(data.mass_thresholds.receipt_seconds)} / 不确定 {data.mass_thresholds.uncertain} 批 / 至少 {data.mass_thresholds.failure_sample_minimum} 批已知终态后未成功比例 {data.mass_thresholds.failure_rate_percent}%。告警只写入站内通知，不开启发送或重发。</p>
    </section>
    <section><h2 className="font-semibold">公众号群发 · 平台批次汇总</h2><p className="mt-1 text-xs text-slate-500">当前队列与最近 24 小时终态分开统计，平台汇总最多缓存 30 秒。未来计划、静默等待、限频延后及暂停不计入到期积压；平台确认批次成功不代表每位客户收到或阅读。</p></section>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards.map(item=><div key={item.label} className="rounded-2xl border bg-white p-5"><item.icon className="text-blue-600"/><p className="mt-4 text-sm text-slate-500">{item.label}</p><p className="mt-1 text-2xl font-semibold">{item.value}</p></div>)}</div>
    <section className="rounded-2xl border bg-white p-5 shadow-sm"><h2 className="font-semibold">租户群发批次</h2><p className="text-xs text-slate-500">按企业分页搜索，包含无活动的企业；只加载当前页 20 个企业的统计，不显示消息正文和客户身份。</p><AdminListNavigation path="/internal-admin/campaigns" q={filter.q} page={filter.page} hasMore={data.has_more} placeholder="搜索企业名称、租户 ID、成员邮箱或手机号"/><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[1100px] text-left text-sm"><thead><tr className="border-b text-slate-500"><th className="p-2">企业</th><th>待处理／到期</th><th>已暂停</th><th>等待微信</th><th>不确定</th><th>最长到期等待</th><th>最长平台等待</th><th>24小时成功／未成功</th><th>未成功比例</th></tr></thead><tbody>{data.tenants.map(row=><tr key={row.tenant_id} className="border-b last:border-0"><td className="p-2"><b>{row.name}</b><div className="font-mono text-[11px] text-slate-400">{row.tenant_id}</div></td><td>{row.mass.pending_batches}／{row.mass.ready_batches} 批</td><td>{row.mass.paused_batches} 批</td><td>{row.mass.awaiting_receipt_batches} 批</td><td className={row.mass.uncertain_batches?'font-semibold text-amber-700':''}>{row.mass.uncertain_batches} 批</td><td>{duration(row.mass.oldest_ready_seconds)}</td><td>{duration(row.mass.oldest_receipt_seconds)}</td><td>{row.mass.succeeded_batches_24h}／{row.mass.unsuccessful_batches_24h} 批</td><td>{row.mass.failure_rate_percent}%</td></tr>)}</tbody></table>{!data.tenants.length&&<p className="py-8 text-center text-sm text-slate-500">未找到匹配的企业。</p>}</div></section>
    <section className="rounded-2xl border bg-slate-50 p-5 text-sm"><h2 className="font-semibold">旧模拟投递 · 独立口径</h2><p className="mt-2 text-slate-500">模拟监控：{data.monitor_enabled?'开启':'关闭'} · 待处理 {s.pending} 条 · 24小时模拟成功 {s.delivered_24h} 条 · 永久失败 {s.dead_24h} 条 · 最长等待 {duration(s.oldest_pending_seconds)}。这些不是公众号群发批次或真实送达人数。</p></section>
  </PlatformAdminShell>;
}
