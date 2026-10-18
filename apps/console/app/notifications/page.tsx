import { ConsoleContentTabs } from "../../components/console-content-tabs";
import { ConsolePageHeading } from "../../components/console-page-heading";
import { AlertTriangle, Bell, BellRing, CheckCheck, Clock3, Eye, ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";
import { ConsoleAccessDenied } from "../../components/console-access-denied";
import { fetchConsoleSession, gatewayUrl, sessionToken } from "../../lib/console-session";
import { BrowserPushCard } from "../../components/browser-push-card";
import { ConsoleShell } from "../../components/console-shell";
import { getConsoleLocale } from "../../lib/console-locale-server";
import { DeleteNotificationDestinationButton } from "../../components/delete-notification-destination-button";
import {webhookDeliveryLabel,notificationActionResult,type WebhookDeliveryState} from '../../lib/webhook-delivery-labels';

export const dynamic = "force-dynamic";

type Delivery = WebhookDeliveryState & {channel:string};
type Notification = {
  notification_id: string;
  event_type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  summary: string;
  status: "open" | "acknowledged" | "resolved";
  occurrence_count: number;
  last_occurred_at: string;
  acknowledged_at: string | null;
  escalated_at: string | null;
  is_read: boolean;
  deliveries: Delivery[];
};
type Preference = {
  channels: string[];
  minimum_external_severity: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
  timezone: string;
  escalation_minutes: number;
  message_notification_mode: "off" | "every_message" | "unattended" | "both";
  unattended_minutes: number;
  include_message_preview: boolean;
};
type Destination = {
  destination_id: string;
  provider: "feishu" | "wecom" | "dingtalk" | "custom";
  display_name: string;
  endpoint_host: string;
  status: "active" | "disabled";
  last_tested_at: string | null;
  last_test_status: "delivered" | "failed" | null;
  signing_configured: boolean;
  test_delivery?:WebhookDeliveryState|null;
};

function localTime(value: string, en = false) {
  return new Intl.DateTimeFormat(en ? "en-US" : "zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(value));
}

function severityStyle(severity: Notification["severity"]) {
  if (severity === "critical") return "border-red-200 bg-red-50 text-red-800";
  if (severity === "warning") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-blue-200 bg-blue-50 text-blue-800";
}

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const session = await fetchConsoleSession();
  const locale = await getConsoleLocale();
  const en = locale === "en";
  const token = await sessionToken();
  if (!session || !token) redirect("/login?error=expired");
  const workspace = session.workspaces.find(item => item.tenant_id === session.selected_tenant_id);
  if (!workspace) redirect("/workspaces");
  if (workspace.role === "agent") return <ConsoleAccessDenied session={session} workspace={workspace} activePath="/notifications"/>;
  const headers = { authorization: `Bearer ${token}` };
  const [notificationsResponse, preferencesResponse, destinationsResponse] = await Promise.all([
    fetch(gatewayUrl("/api/v1/notifications?status=active&limit=100"), { headers, cache: "no-store" }),
    fetch(gatewayUrl("/api/v1/notification-preferences"), { headers, cache: "no-store" }),
    workspace.role === "tenant_admin"
      ? fetch(gatewayUrl("/api/v1/notification-destinations"), { headers, cache: "no-store" })
      : Promise.resolve(undefined),
  ]);
  if (notificationsResponse.status === 401 || preferencesResponse.status === 401) redirect("/login?error=expired");
  const notificationsBody = await notificationsResponse.json() as { data?: Notification[] };
  const preferencesBody = await preferencesResponse.json() as { data?: Preference; enterprise_wechat_mode?: string };
  const notifications = notificationsBody.data ?? [];
  const preference = preferencesBody.data;
  const destinationsBody = destinationsResponse ? await destinationsResponse.json() as { data?: Destination[] } : undefined;
  const destinations = destinationsBody?.data ?? [];
  const query = await searchParams;
  const unread = notifications.filter(item => !item.is_read).length;

  return (
    <ConsoleShell session={session} workspace={workspace} activePath="/notifications" statusPageUrl={process.env.STATUS_PUBLIC_URL ?? "http://localhost:3300"}><main className="mx-auto min-h-screen max-w-5xl p-4 md:p-8">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div><ConsolePageHeading icon="notifications">{en ? "Notifications" : "通知中心"}</ConsolePageHeading><p className="mt-2 text-sm leading-6 text-[var(--ink-500)]">{en ? `Receive team alerts for new messages, unattended conversations and service issues. ${notifications.length} active, ${unread} unread.` : `接收新消息、超时未处理会话与服务异常提醒，并设置团队通知方式。当前 ${notifications.length} 条活动通知，${unread} 条未读。`}</p></div>
        <a href="/settings/communications" className="rounded-xl border border-[var(--border-subtle)] bg-white px-4 py-2.5 text-sm font-semibold">{en ? "Workspace settings" : "企业设置"}</a>
      </div>

      {query.result && <div role="status" className={`mt-5 rounded-xl border p-4 text-sm ${notificationActionResult(query.result,en).tone==='error'?'border-red-200 bg-red-50 text-red-800':notificationActionResult(query.result,en).tone==='warning'?'border-amber-200 bg-amber-50 text-amber-800':notificationActionResult(query.result,en).tone==='info'?'border-blue-200 bg-blue-50 text-blue-800':'border-green-200 bg-green-50 text-green-800'}`}>{notificationActionResult(query.result,en).message}</div>}

      <ConsoleContentTabs en={en} label={en?"Notification sections":"通知中心分区"} panels={[{id:"notifications",label:en?"Notifications":"待处理通知",content:<>      <section className="mt-6 space-y-3">
        {!notifications.length && <div className="rounded-2xl border border-[var(--border-subtle)] bg-white p-8 text-center shadow-[var(--shadow-card)]"><ShieldCheck className="mx-auto text-green-600" /><h2 className="mt-3 font-semibold">{en ? "No active notifications" : "当前没有活动通知"}</h2><p className="mt-1 text-sm text-[var(--ink-500)]">{en ? "System and channel events that need attention will appear here." : "需要处理的系统或渠道事件会显示在这里。"}</p></div>}
        {notifications.map(item => (
          <article key={item.notification_id} className={`rounded-2xl border bg-white p-5 shadow-[var(--shadow-card)] ${item.is_read ? "border-[var(--border-subtle)]" : "border-blue-300"}`}>
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${severityStyle(item.severity)}`}>{item.severity === "critical" ? (en ? "Critical" : "紧急") : item.severity === "warning" ? (en ? "Warning" : "警告") : (en ? "Info" : "提示")}</span><span className="font-mono text-xs text-[var(--ink-500)]">{item.event_type}</span>{item.occurrence_count > 1 && <span className="text-xs text-[var(--ink-500)]">{en ? `Repeated ${item.occurrence_count} times` : `重复 ${item.occurrence_count} 次`}</span>}</div>
                <h2 className="mt-3 font-semibold">{item.title}</h2><p className="mt-1 text-sm leading-6 text-[var(--ink-700)]">{item.summary}</p>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--ink-500)]"><span className="inline-flex items-center gap-1"><Clock3 size={13} />{localTime(item.last_occurred_at, en)}</span><span>{en ? "Status" : "状态"}：{item.status}</span>{item.escalated_at && <span className="text-red-700">{en ? "Escalated" : "已升级"}</span>}</div>
                <div className="mt-2 flex flex-wrap gap-2">{item.deliveries.map((delivery,index) => <span key={`${delivery.channel}-${index}`} className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-[var(--ink-500)]">{delivery.channel}: {webhookDeliveryLabel(delivery,en)}{delivery.channel==='webhook'&&<> · {en?'Attempts':'已尝试'} {delivery.attempt_count}/5{delivery.status==='pending'&&delivery.next_attempt_at&&delivery.error_code!=='webhook_in_progress'&&<> · {en?'Next attempt':'下次尝试'} {localTime(delivery.next_attempt_at,en)}</>}</>}</span>)}</div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {!item.is_read && <form action={`/api/notifications/${item.notification_id}/read`} method="post"><button className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs font-semibold"><Eye size={14} />{en ? "Mark read" : "标为已读"}</button></form>}
                {item.status === "open" && <form action={`/api/notifications/${item.notification_id}/acknowledge`} method="post"><button className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-500)] px-3 py-2 text-xs font-semibold text-white"><CheckCheck size={14} />{en ? "Acknowledge" : "确认处理"}</button></form>}
                {workspace.role === "tenant_admin" && item.status !== "resolved" && <form action={`/api/notifications/${item.notification_id}/resolve`} method="post"><button className="inline-flex items-center gap-1.5 rounded-lg border border-green-300 px-3 py-2 text-xs font-semibold text-green-700">{en ? "Resolve" : "标记解决"}</button></form>}
              </div>
            </div>
          </article>
        ))}
      </section>

</>},{id:"notification-settings",label:en?"Preferences & push":"提醒偏好与推送",content:<>      {workspace.role === "tenant_admin" && preference && <section className="mt-8 rounded-2xl border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)]">
        <div className="flex items-center gap-2"><Bell size={19} /><h2 className="font-semibold">{en ? "Notification preferences" : "通知偏好"}</h2></div>
        <p className="mt-1 text-sm text-[var(--ink-500)]">{en ? "In-app notifications are always on. WeCom application alerts are not available; you can add a WeCom bot below." : "站内通知始终开启。企业微信应用通知暂未开放；如需企业微信提醒，可在下方添加机器人通知目标。"}</p>
        <form action="/api/notification-preferences" method="post" className="mt-5 grid gap-4 md:grid-cols-2">
          <label className="text-sm"><span className="font-medium">{en ? "Channels" : "通知渠道"}</span><div className="mt-2 flex flex-wrap gap-4"><span><input type="checkbox" checked disabled className="mr-1.5" />{en ? "In-app" : "站内"}</span><label><input type="checkbox" name="channels" value="browser_push" defaultChecked={preference.channels.includes("browser_push")} className="mr-1.5" />{en ? "Browser push" : "浏览器推送"}</label><label><input type="checkbox" name="channels" value="chatwoot" defaultChecked={preference.channels.includes("chatwoot")} className="mr-1.5" />{en ? "Conversation notes" : "会话内提醒"}</label><label><input type="checkbox" name="channels" value="enterprise_wechat" defaultChecked={preference.channels.includes("enterprise_wechat")} className="mr-1.5" />{en ? "WeCom" : "企业微信"}</label></div></label>
          <label className="text-sm"><span className="font-medium">{en ? "Minimum external severity" : "外部通知最低级别"}</span><select name="minimum_external_severity" defaultValue={preference.minimum_external_severity} className="mt-2 w-full rounded-lg border border-[var(--border-subtle)] px-3 py-2"><option value="info">{en ? "Info" : "提示"}</option><option value="warning">{en ? "Warning" : "警告"}</option><option value="critical">{en ? "Critical" : "紧急"}</option></select></label>
          <label className="text-sm"><span className="font-medium">{en ? "Quiet hours start" : "静默开始"}</span><input type="time" name="quiet_hours_start" defaultValue={preference.quiet_hours_start.slice(0, 5)} className="mt-2 w-full rounded-lg border border-[var(--border-subtle)] px-3 py-2" /></label>
          <label className="text-sm"><span className="font-medium">{en ? "Quiet hours end" : "静默结束"}</span><input type="time" name="quiet_hours_end" defaultValue={preference.quiet_hours_end.slice(0, 5)} className="mt-2 w-full rounded-lg border border-[var(--border-subtle)] px-3 py-2" /></label>
          <label className="text-sm"><span className="font-medium">{en ? "Time zone" : "时区"}</span><input name="timezone" defaultValue={preference.timezone} className="mt-2 w-full rounded-lg border border-[var(--border-subtle)] px-3 py-2" /></label>
          <label className="text-sm"><span className="font-medium">{en ? "Escalate if unacknowledged (minutes)" : "未确认升级（分钟）"}</span><input type="number" min="5" max="1440" name="escalation_minutes" defaultValue={preference.escalation_minutes} className="mt-2 w-full rounded-lg border border-[var(--border-subtle)] px-3 py-2" /></label>
          <label className="text-sm"><span className="font-medium">{en ? "Customer message alerts" : "客户消息通知策略"}</span><select name="message_notification_mode" defaultValue={preference.message_notification_mode} className="mt-2 w-full rounded-lg border border-[var(--border-subtle)] px-3 py-2"><option value="off">{en ? "External alerts off" : "关闭外部消息通知"}</option><option value="every_message">{en ? "Every new message" : "每条新消息"}</option><option value="unattended">{en ? "Only when unattended" : "长时间未处理"}</option><option value="both">{en ? "Both" : "两者都通知"}</option></select></label>
          <label className="text-sm"><span className="font-medium">{en ? "Unattended threshold (minutes)" : "未处理提醒（分钟）"}</span><input type="number" min="1" max="1440" name="unattended_minutes" defaultValue={preference.unattended_minutes} className="mt-2 w-full rounded-lg border border-[var(--border-subtle)] px-3 py-2" /></label>
          <label className="text-sm md:col-span-2"><span className="inline-flex items-start gap-2"><input type="checkbox" name="include_message_preview" defaultChecked={preference.include_message_preview} className="mt-1" /><span><strong className="block font-medium">{en ? "Include a message preview in external alerts" : "在外部通知中包含消息预览"}</strong><span className="text-[var(--ink-500)]">{en ? "Off by default. When enabled, up to 120 characters of a customer message are sent to your third-party webhook. Confirm this matches your privacy policy." : "默认关闭。开启后，最多 120 字客户消息会发送给您配置的第三方 Webhook，请确认符合企业隐私政策。"}</span></span></span></label>
          <div className="md:col-span-2"><button type="submit" className="rounded-xl bg-[var(--brand-500)] px-4 py-2.5 text-sm font-semibold text-white">{en ? "Save preferences" : "保存通知偏好"}</button></div>
        </form>
      </section>}

      <BrowserPushCard locale={locale} />

</>},...(workspace.role==="tenant_admin"?[{id:"notification-webhooks",label:en?"Webhook destinations":"Webhook 接收端",content:<>      {workspace.role === "tenant_admin" && <section className="mt-8 rounded-2xl border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)]">
        <div className="flex items-center gap-2"><AlertTriangle size={19} /><h2 className="font-semibold">{en ? "Webhook destinations" : "Webhook 通知目标"}</h2></div>
        <p className="mt-1 text-sm leading-6 text-[var(--ink-500)]">{en ? "Supports Feishu, WeCom, DingTalk and custom HTTPS webhooks. URLs are encrypted and only the host is shown; DingTalk messages always contain the keyword ReplyNest." : "支持飞书、企业微信、钉钉和自定义 HTTPS Webhook。地址加密保存，页面仅显示域名；钉钉通知固定包含关键词 ReplyNest。"}</p>
        <div className="mt-5 space-y-3">
          {!destinations.length && <p className="rounded-xl bg-slate-50 p-4 text-sm text-[var(--ink-500)]">{en ? "No webhook destination configured." : "尚未配置 Webhook 通知目标。"}</p>}
          {destinations.map(item => <div key={item.destination_id} className="flex flex-col justify-between gap-3 rounded-xl border border-[var(--border-subtle)] p-4 sm:flex-row sm:items-center">
            <div><p className="font-medium">{item.display_name}</p><p className="mt-1 text-xs text-[var(--ink-500)]">{item.provider} · {item.endpoint_host} · {item.status === "active" ? "已启用" : "已停用"}{item.test_delivery?` · ${en?'Latest test':'最近测试'}：${webhookDeliveryLabel(item.test_delivery,en)} · ${item.test_delivery.attempt_count}/5`:item.last_test_status?` · ${en?'Latest test':'最近测试'}：${webhookDeliveryLabel({status:item.last_test_status,attempt_count:0},en)}`:''}</p>{item.test_delivery?.status==='pending'&&item.test_delivery.next_attempt_at&&item.test_delivery.error_code!=='webhook_in_progress'&&<p className="mt-1 text-xs text-[var(--ink-500)]">{en?'Next attempt':'下次尝试'}：{localTime(item.test_delivery.next_attempt_at,en)}</p>}</div>
            <div className="flex flex-wrap gap-2">
              {item.status === "active" && <form action={`/api/notification-destinations/${item.destination_id}/test`} method="post"><button disabled={item.test_delivery?.status==='pending'} className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs font-semibold disabled:opacity-40">{item.test_delivery?.status==='pending'?(en?'Test in progress':'测试进行中'):en ? "Send test" : "发送测试"}</button></form>}
              <form action={`/api/notification-destinations/${item.destination_id}`} method="post"><input type="hidden" name="display_name" value={item.display_name} /><input type="hidden" name="status" value={item.status === "active" ? "disabled" : "active"} /><button className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs font-semibold">{item.status === "active" ? (en ? "Disable" : "停用") : (en ? "Enable" : "启用")}</button></form>
              {item.status === "disabled" && <DeleteNotificationDestinationButton id={item.destination_id} name={item.display_name} en={en}/>}
            </div>
          </div>)}
        </div>
        <form action="/api/notification-destinations" method="post" className="mt-6 grid gap-4 md:grid-cols-2">
          <label className="text-sm"><span className="font-medium">类型</span><select name="provider" className="mt-2 w-full rounded-lg border border-[var(--border-subtle)] px-3 py-2"><option value="feishu">飞书机器人</option><option value="wecom">企业微信机器人</option><option value="dingtalk">钉钉机器人</option><option value="custom">自定义 Webhook</option></select></label>
          <label className="text-sm"><span className="font-medium">显示名称</span><input required maxLength={80} name="display_name" placeholder="例如：客服值班群" className="mt-2 w-full rounded-lg border border-[var(--border-subtle)] px-3 py-2" /></label>
          <label className="text-sm md:col-span-2"><span className="font-medium">Webhook HTTPS 地址</span><input required type="url" name="endpoint" autoComplete="off" placeholder="https://..." className="mt-2 w-full rounded-lg border border-[var(--border-subtle)] px-3 py-2" /></label>
          <label className="text-sm md:col-span-2"><span className="font-medium">自定义 Webhook HMAC 密钥（可选）</span><input type="password" minLength={16} maxLength={256} name="signing_secret" autoComplete="new-password" className="mt-2 w-full rounded-lg border border-[var(--border-subtle)] px-3 py-2" /><span className="mt-1 block text-xs text-[var(--ink-500)]">仅自定义 Webhook 使用；第三方机器人 Token 已包含在地址中。</span></label>
          <div className="md:col-span-2"><button type="submit" className="rounded-xl bg-[var(--brand-500)] px-4 py-2.5 text-sm font-semibold text-white">{en ? "Add destination" : "添加通知目标"}</button></div>
        </form>
      </section>}
</>}]:[])]}/>
    </main></ConsoleShell>
  );
}
