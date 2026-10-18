import {
  Activity,
  ArrowRight,
  Bot,
  BellRing,
  CheckCircle2,
  Headphones,
  MessageCircleMore,
  ShieldCheck,
} from "lucide-react";
import { redirect } from "next/navigation";
import { ConsoleShell } from "../components/console-shell";
import { fetchConsoleSession, gatewayUrl, sessionToken } from "../lib/console-session";
import { changeNote, fetchOperationsMetrics, formatDuration, type OperationsMetrics } from "../lib/operations-metrics";
import { getConsoleLocale } from "../lib/console-locale-server";
import { canAccessConsolePath } from "../lib/console-access";
import type { ConsoleLocale } from "../lib/console-i18n";
import { CustomerInsightsDashboard } from "../components/customer-insights-dashboard";

export const dynamic = "force-dynamic";

function dashboardCards(data: OperationsMetrics | undefined, locale: ConsoleLocale) {
  const en = locale === "en";
  const value = (number: number | null | undefined, suffix = "") => number === null || number === undefined ? "—" : `${number}${suffix}`;
  return [
    { label: en ? "Conversations today" : "今日咨询", value: value(data?.metrics.conversations.value), note: data ? changeNote(data.metrics.conversations.change_percent, locale) : (en ? "Metrics unavailable" : "数据服务暂不可用"), tone: "positive" },
    { label: en ? "Customers served today" : "今日接待客户", value: value(data?.metrics.served_customers.value), note: en ? "Deduplicated by public agent replies" : "按人工公开回复去重", tone: "neutral" },
    { label: en ? "New customers today" : "今日新客户", value: value(data?.metrics.new_customers.value), note: data ? changeNote(data.metrics.new_customers.change_percent, locale) : (en ? "Metrics unavailable" : "数据服务暂不可用"), tone: "positive" },
    { label: en ? "First response time" : "首次响应时间", value: formatDuration(data?.metrics.first_response_seconds.value ?? null, locale), note: en ? "Calendar-time average" : "自然时间平均值", tone: "neutral" },
    { label: en ? "Resolution rate today" : "今日解决率", value: value(data?.metrics.resolution_rate.value, "%"), note: data ? `${data.metrics.resolution_rate.numerator ?? 0}/${data.metrics.resolution_rate.denominator ?? 0} ${en ? "conversations" : "条会话"}` : (en ? "Metrics unavailable" : "数据服务暂不可用"), tone: "neutral" },
    { label: en ? "AI suggestion adoption this week" : "本周 AI 建议采用率", value: value(data?.metrics.ai_adoption_rate.value, "%"), note: data ? `${data.metrics.ai_adoption_rate.numerator ?? 0}/${data.metrics.ai_adoption_rate.denominator ?? 0} ${en ? "comparable suggestions" : "条可比建议"}` : (en ? "Metrics unavailable" : "数据服务暂不可用"), tone: "ai" },
  ];
}

export default async function ConsoleHome() {
  const locale = await getConsoleLocale();
  const en = locale === "en";
  const token = await sessionToken();
  const session = await fetchConsoleSession();
  if (!session) redirect(token ? "/login?error=expired" : "/login");
  if (!session.selected_tenant_id) redirect("/workspaces");
  const workspace = session.workspaces.find(item => item.tenant_id === session.selected_tenant_id);
  if (!workspace) redirect("/workspaces");
  const dashboard = await fetchOperationsMetrics(token!);
  const channels = await fetch(gatewayUrl("/api/v1/channels"), { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(5000) }).then(async response => response.ok ? (await response.json()).data as Array<{ channel_type: string; status: string }> : []).catch(() => []);
  const websiteReady = channels.some(item => item.channel_type === "web_chat" && item.status === "ready");
  const metrics = dashboardCards(dashboard, locale);
  const attentionTotal = dashboard ? dashboard.attention.outbound_failures + dashboard.attention.expiring_policies + (dashboard.attention.expiring_documents??0) + dashboard.attention.failed_knowledge_jobs : 0;
  const steps = [
    { label: en ? "Create a workspace" : "创建企业工作区", done: true },
    { label: en ? "Connect a WeChat Official Account" : "接入微信公众号", done: (dashboard?.onboarding.ready_channels ?? 0) > 0 },
    { label: en ? "Import business knowledge" : "导入企业知识", done: (dashboard?.onboarding.active_knowledge_documents ?? 0) > 0 },
    { label: en ? "Invite support agents" : "邀请客服成员", done: (dashboard?.onboarding.active_members ?? 0) > 1 },
    { label: en ? "Complete a test conversation" : "完成一条测试会话", done: (dashboard?.onboarding.processed_inbound_events ?? 0) > 0 },
  ];
  const completedSteps = steps.filter(step => step.done).length;
  const progress = completedSteps * 20;
  const statusPageUrl = process.env.STATUS_PUBLIC_URL ?? "http://localhost:3300";
  return (
    <ConsoleShell session={session} workspace={workspace} activePath="/" statusPageUrl={statusPageUrl} pwaInstallEligible={(dashboard?.onboarding.ready_channels ?? 0) > 0}>
        <main id="main" className="mx-auto max-w-[1440px] space-y-6 p-4 md:p-5">
          <section className="overflow-hidden rounded-[var(--radius-lg)] border border-blue-100 bg-gradient-to-br from-[var(--brand-50)] via-white to-[var(--ai-soft)] p-5 shadow-[var(--shadow-card)] md:flex md:items-center md:justify-between md:p-7">
            <div className="max-w-2xl"><h1 className="text-2xl font-semibold tracking-tight md:text-2xl">{en ? "Handle the most important customer issues first" : "先处理最重要的客户问题"}</h1><p className="mt-2 text-sm leading-6 text-[var(--ink-700)] md:text-base">{dashboard ? (attentionTotal ? (en ? `${attentionTotal} operational exceptions or expiring items need attention.` : `当前有 ${attentionTotal} 项运营异常或临期事项，请优先检查。`) : (en ? "There are no outbound failures, expiring policies or failed knowledge jobs." : "当前没有出站失败、临期政策或知识任务异常。")) : (en ? "Operational metrics are unavailable. Continue handling conversations in the support workspace." : "运营指标暂时不可用，请进入客服工作台继续处理会话。")}</p><p className="mt-2 text-xs text-[var(--ink-500)]">{en ? "Definition" : "口径"} {dashboard?.definition_version ?? "operations-v1"} · {en ? "Time zone" : "时区"} {dashboard?.period.timezone ?? (en ? "Unavailable" : "暂不可用")} · {dashboard ? (en ? "Live aggregation" : "实时聚合") : (en ? "Degraded view" : "降级显示")}</p></div>
            <a href="/workbench?status=open" className="mt-5 inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-white px-4 py-3 text-sm font-semibold text-[var(--brand-700)] shadow-sm md:mt-0">{en ? "View waiting conversations" : "查看待接待会话"}<ArrowRight size={16} /></a>
          </section>

          <section className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
            <article className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)] md:p-6">
              <div className="flex items-center justify-between"><div><h2 className="font-semibold">{en ? "Needs attention" : "需要关注"}</h2><p className="mt-1 text-xs text-[var(--ink-500)]">{en ? "Ordered by risk and urgency" : "按风险与紧迫程度排序"}</p></div><Activity size={20} className="text-[var(--ink-500)]" /></div>
              <div className="mt-5 divide-y divide-[var(--border-subtle)]">
                <Alert icon={<MessageCircleMore size={18} />} title={en ? `${dashboard?.attention.outbound_failures ?? 0} outbound messages failed` : `${dashboard?.attention.outbound_failures ?? 0} 条出站消息失败`} detail={en ? "Permanent errors are not retried; temporary errors use policy backoff" : "永久错误不会自动重试；临时错误按策略退避"} action={en ? "View failures" : "查看失败"} href={canAccessConsolePath("/operations/outbound", workspace.role) ? "/operations/outbound" : undefined} tone="warning" />
                <Alert icon={<ShieldCheck size={18} />} title={en ? `${dashboard?.attention.expiring_documents ?? 0} knowledge documents expire within 3 days` : `${dashboard?.attention.expiring_documents ?? 0} 份知识文档将在 3 天内到期`} detail={en ? `Long-term and temporary published documents. ${dashboard?.attention.expiring_policies??0} legacy policies also expire soon.` : `统一统计长期与临时已发布文档；另有 ${dashboard?.attention.expiring_policies??0} 条旧政策临期。`} action={en ? "View knowledge" : "查看知识库"} tone="ai" href="/knowledge?filter=expiring" />
                <Alert icon={<Bot size={18} />} title={en ? `${dashboard?.attention.failed_knowledge_jobs ?? 0} knowledge jobs need attention` : `${dashboard?.attention.failed_knowledge_jobs ?? 0} 个知识任务需要处理`} detail={en ? "Includes failed jobs and jobs in the dead-letter state" : "包含失败和进入死信状态的任务"} action={en ? "View knowledge" : "查看知识库"} tone={dashboard?.attention.failed_knowledge_jobs ? "warning" : "success"} />
              </div>
            </article>

            <article className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)] md:p-6">
              <div className="flex items-center justify-between"><div><h2 className="font-semibold">{en ? "Getting started" : "开始使用"}</h2><p className="mt-1 text-xs text-[var(--ink-500)]">{completedSteps}/5 {en ? "complete" : "已完成"}</p></div><span className="rounded-full bg-[var(--brand-50)] px-2.5 py-1 text-xs font-semibold text-[var(--brand-700)]">{progress}%</span></div>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-[var(--brand-500)]" style={{ width: `${progress}%` }} /></div>
              <ol className="mt-4 space-y-3">{steps.map((step) => <li key={step.label} className="flex items-center gap-3 text-sm"><CheckCircle2 size={18} className={step.done ? "text-[var(--success)]" : "text-slate-300"} /><span className={step.done ? "text-[var(--ink-500)] line-through" : "font-medium"}>{step.label}</span></li>)}</ol>
            </article>
          </section>

          <section className="grid grid-cols-2 gap-3 xl:grid-cols-6">
            {metrics.map((metric) => <article key={metric.label} className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-white p-4 shadow-[var(--shadow-card)] md:p-5"><p className="text-xs font-medium text-[var(--ink-500)] md:text-sm">{metric.label}</p><p className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">{metric.value}</p><p className={`mt-2 text-xs ${metric.tone === "positive" ? "text-[var(--success)]" : metric.tone === "ai" ? "text-[var(--ai)]" : "text-[var(--ink-500)]"}`}>{metric.note}</p></article>)}
          </section>

          {process.env.CONSOLE_CUSTOMER_INSIGHTS_ENABLED === "true" && !session.impersonation && ["tenant_admin", "supervisor"].includes(workspace.role) && <CustomerInsightsDashboard key={workspace.tenant_id} workspaceId={workspace.tenant_id} canManage={workspace.role === "tenant_admin"} locale={locale} />}

          <section className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)] md:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-semibold">{en ? "Channel status" : "渠道运行状态"}</h2><p className="mt-1 text-xs text-[var(--ink-500)]">{en ? "Connection health, recent messages and exceptions in one place" : "接入健康度、最近消息与异常统一查看"}</p></div><a href="/channels" className="self-start rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm font-medium">{en ? "Manage channels" : "管理渠道"}</a></div>
            <div className="mt-5 grid gap-3 md:grid-cols-3"><Channel name={en ? "WeChat Official Account" : "微信公众号"} status={(dashboard?.onboarding.ready_channels ?? 0) > 0 ? (en ? "Connection validated" : "已通过接入校验") : (en ? "Setup required" : "待完成接入")} detail={en ? "Status comes from this workspace’s channel connection" : "状态来自当前企业渠道连接记录"} ready={(dashboard?.onboarding.ready_channels ?? 0) > 0} /><Channel name={en ? "Website chat" : "网站聊天"} status={websiteReady ? (en ? "Configured" : "已配置") : (en ? "Not connected" : "尚未接入")} detail={en ? "Configure and copy embed code under Channels" : "前往渠道与接入，配置并复制嵌入代码"} ready={websiteReady} /><Channel name={en ? "WeChat Mini Program" : "微信小程序"} status={en ? "Planned" : "规划中"} detail={en ? "Outside the current pilot scope" : "不属于当前样品范围"} /></div>
          </section>
        </main>
    </ConsoleShell>
  );
}

function Alert({ icon, title, detail, action, tone, href }: { icon: React.ReactNode; title: string; detail: string; action: string; tone: "warning" | "ai" | "success"; href?: string }) {
  const tones = { warning: "bg-[var(--warning-soft)] text-[var(--warning)]", ai: "bg-[var(--ai-soft)] text-[var(--ai)]", success: "bg-[var(--success-soft)] text-[var(--success)]" };
  return <div className="flex items-center gap-3 py-4 first:pt-0 last:pb-0"><div className={`grid size-10 shrink-0 place-items-center rounded-xl ${tones[tone]}`}>{icon}</div><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{title}</p><p className="mt-1 text-xs text-[var(--ink-500)]">{detail}</p></div>{href ? <a href={href} className="shrink-0 text-xs font-semibold text-[var(--brand-700)]">{action}</a> : null}</div>;
}

function Channel({ name, status, detail, ready = false }: { name: string; status: string; detail: string; ready?: boolean }) {
  return <div className="rounded-xl border border-[var(--border-subtle)] p-4"><div className="flex items-center justify-between"><p className="text-sm font-semibold">{name}</p><span className={`rounded-full px-2 py-1 text-[11px] font-medium ${ready ? "bg-[var(--success-soft)] text-[var(--success)]" : "bg-slate-100 text-[var(--ink-500)]"}`}>{status}</span></div><p className="mt-3 text-xs text-[var(--ink-500)]">{detail}</p></div>;
}
