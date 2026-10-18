import { ConsolePageHeading } from "../../../components/console-page-heading";
import { redirect } from "next/navigation";
import { ConsoleAccessDenied } from "../../../components/console-access-denied";
import { fetchConsoleSession, gatewayUrl, sessionToken } from "../../../lib/console-session";
import { ConsoleShell } from "../../../components/console-shell";
import { getConsoleLocale } from "../../../lib/console-locale-server";
import { ConversationAutomationControls } from "../../../components/conversation-automation-controls";

export const dynamic = "force-dynamic";
type AutomationSettings = { automatic_sending_enabled: boolean; ai_auto_reply_enabled: boolean; ai_auto_send_confidence_threshold_percent: number; runtime_executor_available: boolean };

export default async function CommunicationsPage() {
  const locale = await getConsoleLocale(); const en = locale === "en";
  const session = await fetchConsoleSession();
  const token = await sessionToken();
  if (!session || !token) redirect("/login?error=expired");
  const workspace = session.workspaces.find(item => item.tenant_id === session.selected_tenant_id);
  if (!workspace) redirect("/workspaces");
  if (workspace.role !== "tenant_admin") return <ConsoleAccessDenied session={session} workspace={workspace} activePath="/settings/communications"/>;
  const automationUpstream = await fetch(gatewayUrl("/api/v1/conversation-automation"), {
    headers: { authorization: `Bearer ${token}`, "x-replynest-workspace": workspace.tenant_id },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000)
  }).catch(() => new Response(null, {status:503}));
  if (automationUpstream.status === 401) redirect("/login?error=expired");
  const automationBody = await automationUpstream.json().catch(() => ({})) as { data?: AutomationSettings };
  const automation = automationBody.data ?? { automatic_sending_enabled: false, ai_auto_reply_enabled: false, ai_auto_send_confidence_threshold_percent: 90, runtime_executor_available: false };
  const automaticManagementAvailable = !session.impersonation && await fetch(gatewayUrl("/api/v1/automatic-reception/management?limit=1"), {
    headers: { authorization: `Bearer ${token}`, "x-replynest-workspace": workspace.tenant_id }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3000)
  }).then(response => response.ok).catch(() => false);
  return (
    <ConsoleShell session={session} workspace={workspace} activePath="/settings/communications" statusPageUrl={process.env.STATUS_PUBLIC_URL ?? "http://localhost:3300"}><main className="mx-auto min-h-screen max-w-4xl p-4 md:p-8">
      <ConsolePageHeading icon="settings">{en ? "Workspace settings" : "企业设置"}</ConsolePageHeading>
      <p className="mt-2 text-sm leading-6 text-[var(--ink-500)]">{en ? "Manage reply automation for your team. To choose how you receive alerts, visit Notifications." : "管理团队的自动回复与发送设置。如需设置消息提醒方式，请前往通知中心。"}</p>
      <nav aria-label={en?'Workspace settings directory':'企业设置目录'} className="mt-6 grid gap-3 sm:grid-cols-2">{[
        ['/settings/communications#reception-mode',en?'Reception mode':'接待模式',en?'Choose human assistance or automatic reception.':'选择人工辅助或自动接待，不替代单独授权。'],
        ...(automaticManagementAvailable?[['/settings/automatic-reception',en?'AI reception settings':'AI 接待设置',en?'Sending, tone, history and profile budget.':'发送授权、语气、历史用途与客户画像预算。']]:[]),
        ['/notifications',en?'Notifications':'通知与推送',en?'Notification preferences and destinations.':'消息提醒、浏览器推送与 Webhook。'],
        ['/settings/members',en?'Team and permissions':'团队与权限',en?'Members, invitations and role descriptions.':'成员列表、邀请与角色权限说明。'],
        ...(!session.impersonation?[['/settings/activity',en?'Account security':'账号安全日志',en?'Load sign-in and action records when needed.':'按需查询登录、操作记录与异常线索。']]:[]),
        ['/settings/privacy',en?'Privacy requests':'隐私与账号请求',en?'Submit a request and track its progress.':'提交申请、核对进度与办理结果。']
      ].map(([href,title,description])=><a key={href} href={href} className="min-w-0 rounded-xl border border-[var(--border-subtle)] bg-white p-4 hover:border-blue-300"><span className="font-semibold text-blue-700">{title} →</span><p className="mt-2 text-sm text-slate-500">{description}</p></a>)}</nav>
      {!automationUpstream.ok && <p role="alert" className="mt-5 text-sm text-amber-800">{en ? "Settings are temporarily unavailable. Please refresh before making changes." : "设置暂时无法读取，请刷新后再修改。"}</p>}
      <section id="reception-mode" className="scroll-mt-6">{automationUpstream.ok && automationBody.data && <ConversationAutomationControls initial={automation} en={en} workspaceId={workspace.tenant_id} />}</section>
      {automaticManagementAvailable && <section className="mt-6 rounded-2xl border border-[var(--border-subtle)] bg-white p-5">
        <h2 className="font-semibold">{en ? "Knowledge-based automatic reception" : "知识库自动接待"}</h2>
        <p className="mt-2 text-sm text-[var(--ink-500)]">{en ? "Manage sending authorization and AI point usage. AI answers from verified published knowledge; uncertain or high-risk questions need human help." : "管理发送授权与 AI 点数消费。AI 从已发布知识库核验来源后回答；低置信度或高风险问题交人工处理。"}</p>
        <a href="/settings/automatic-reception" className="mt-3 inline-flex text-sm font-semibold text-[var(--brand-700)]">{en ? "Manage knowledge-based reception →" : "管理知识库接待 →"}</a>
      </section>}
    </main></ConsoleShell>
  );
}
