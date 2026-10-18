import {
  ArrowLeft, CheckCircle2, ChevronRight, Clock3, Download,
  FileText, ImageIcon, Inbox, MessageCircleMore, Paperclip, RefreshCw, UserRound
} from "lucide-react";
import { redirect } from "next/navigation";
import { WorkbenchPushPrompt } from "../../components/workbench-push-prompt";
import { wechatDeliveryFailure } from "./wechat-delivery-label";
import { WorkbenchShell } from "../../components/workbench-shell";
import { fetchConsoleSession, gatewayUrl, sessionToken } from "../../lib/console-session";
import { getConsoleLocale } from "../../lib/console-locale-server";
import { ReplyComposer } from "./reply-composer";
import { ConversationSearch } from "./conversation-search";
import { workbenchListState } from './list-state';
import { WorkbenchAutomationStatus } from '../../components/workbench-automation-status';
import { automaticModeStatusText,type ConversationAutomationSettings } from '../../lib/automatic-reception';
import { WorkbenchTools } from "./workbench-tools";
import { ConversationActions } from "./conversation-actions";
import { CustomerDetailsProvider, CustomerDetailsButton, CustomerDetailsPanel, CustomerProfileEditor } from "./customer-details";
import {WorkbenchReadReceipt,UnreadBadge} from '../../components/workbench-read-receipt';
import {CustomerInsightsProfile} from '../../components/customer-insights-profile';
import {CustomerAvatar} from '../../components/customer-avatar';
import {conversationActivity,workbenchChannel,workbenchDelivery,workbenchTransfer} from '../../lib/workbench-labels';

export const dynamic = "force-dynamic";

type Attachment = {
  id: string; kind: string; file_name: string | null; content_type: string | null;
  size_bytes: number | null; width: number | null; height: number | null; download_available: boolean;
  processing_status?:string;
};
type Message = {
  id: string; direction: "incoming" | "outgoing" | "activity" | "template" | "unknown";
  text: string | null; content_type: string; private: boolean; delivery_status: string | null;
  created_at: string | null; sender: { kind: string; display_name: string | null }; attachments: Attachment[];
};
type Conversation = {
  id: string; status: "open" | "pending" | "resolved" | "snoozed" | "unknown";
  priority: string | null; can_reply: boolean; unread_count: number; unread_available?:boolean;unread_capped?:boolean;labels: string[];
  contact: { id: string; display_name: string; channel: string; avatar_url?:string|null } | null;
  assignment: { member_id: string; display_name: string; role: string } | null;
  last_message: Message | null; created_at: string | null; updated_at: string | null;
  last_activity_at: string | null; waiting_since: string | null;
};
type ListBody = { data: Conversation[]; pagination: { next_cursor: string | null }; channel_setup?: {connected: boolean};read_receipts_enabled?:boolean };
type DetailBody = { data: Conversation };
type MessagesBody = { data: Message[]; pagination: { next_cursor: string | null } };
type Assignee = { member_id: string; display_name: string; role: string };
type AssigneesBody = { data: Assignee[] };
type FileTransfer = {
  transfer_id: string; direction: "outbound_download" | "inbound_upload"; status: string;
  file_name: string | null; mime_type: string | null; size_bytes: number | null;
  expires_at: string; created_at: string;
};
type FileTransfersBody = { data: FileTransfer[] };

async function gatewayGet<T>(path: string, token: string, workspaceId?:string): Promise<{ body?: T; status: number; errorCode?: string }> {
  try {
    const response = await fetch(gatewayUrl(path), {
      headers: { authorization: `Bearer ${token}`, ...(workspaceId?{'x-replynest-workspace':workspaceId}:{}) }, cache: "no-store", redirect:'error', signal: AbortSignal.timeout(10_000)
    });
    if (response.ok) return {status: response.status, body: await response.json() as T};
    const error = await response.json().catch(() => null) as {error?: {code?: string}} | null;
    return {status: response.status, errorCode: typeof error?.error?.code === 'string' ? error.error.code : undefined};
  } catch { return { status: 503 }; }
}

function dateTime(value: string | null, en: boolean) {
  if (!value) return en ? "Unknown" : "未知时间";
  const date = new Date(value); if (Number.isNaN(date.getTime())) return en ? "Unknown" : "未知时间";
  return new Intl.DateTimeFormat(en ? "en-US" : "zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
function fileSize(value: number | null, en: boolean) {
  if (value === null) return en ? "Unknown size" : "大小未知";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export default async function WorkbenchPage({ searchParams }: { searchParams: Promise<{ conversation?: string; status?: string; profile?: string; content?: string; from?: string; to?: string; cursor?: string }> }) {
  const locale = await getConsoleLocale(); const en = locale === "en";
  const token = await sessionToken(); const session = await fetchConsoleSession();
  if (!session || !token) redirect("/login?error=expired");
  if (!session.selected_tenant_id) redirect("/workspaces");
  const workspace = session.workspaces.find(item => item.tenant_id === session.selected_tenant_id);
  if (!workspace) redirect("/workspaces");
  const query = await searchParams;
  const status = ["all", "open", "pending", "resolved", "snoozed"].includes(query.status ?? "") ? query.status! : "all";
  const selectedId = /^[0-9a-f-]{36}$/i.test(query.conversation ?? "") ? query.conversation : undefined;
  const filters = new URLSearchParams({status});
  for (const name of ['profile','content','from','to','cursor'] as const) if (typeof query[name] === 'string' && query[name]) filters.set(name,query[name]);
  function workbenchHref(changes: Record<string,string|null> = {}) {
    const params = new URLSearchParams(filters);
    for (const [name,value] of Object.entries(changes)) { if(value === null) params.delete(name); else params.set(name,value); }
    return `/workbench?${params}`;
  }
  const [listResult, assigneesResult, automationResult] = await Promise.all([
    gatewayGet<ListBody>(`/api/v1/conversations?${filters}`, token),
    workspace.role === "tenant_admin" || workspace.role === "supervisor"
      ? gatewayGet<AssigneesBody>("/api/v1/conversation-assignees", token)
      : Promise.resolve<{ body?: AssigneesBody; status: number }>({ status: 403 }),
    gatewayGet<{data:ConversationAutomationSettings}>('/api/v1/conversation-automation',token,workspace.tenant_id)
  ]);
  if (listResult.status === 401) redirect("/login?error=expired");
  const conversations = listResult.body?.data ?? [];
  const listState = workbenchListState(listResult.status, listResult.body?.channel_setup?.connected, listResult.errorCode);
  const [detailResult, messagesResult, transfersResult] = selectedId ? await Promise.all([
    gatewayGet<DetailBody>(`/api/v1/conversations/${encodeURIComponent(selectedId)}`, token),
    gatewayGet<MessagesBody>(`/api/v1/conversations/${encodeURIComponent(selectedId)}/messages`, token),
    gatewayGet<FileTransfersBody>(`/api/v1/conversations/${encodeURIComponent(selectedId)}/file-transfers`, token)
  ]) : [{ status: 0 }, { status: 0 }, { status: 0 }];
  const selected = detailResult.body?.data;
  const messages = (messagesResult.body?.data ?? []).slice().sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  const assignees = assigneesResult.body?.data ?? [];
  const fileTransfers = transfersResult.body?.data ?? [];
  const latestCustomerQuestion = messages.slice().reverse().find(message => message.direction === "incoming" && message.text?.trim())?.text?.trim() ?? "";
  return <WorkbenchShell key={workspace.tenant_id} locale={locale} workspaceName={workspace.tenant_name} preferenceKey={`workbench-style:${workspace.tenant_id}:${session.user.id}`}>
    <CustomerDetailsProvider><main className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-slate-100/70">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-b border-[var(--border-subtle)] bg-white px-3 py-1 md:px-6 md:py-2">
        <div><h1 className="text-xs md:text-base font-semibold">{en ? "Support workspace" : "客服工作台"}</h1><p className="hidden md:block mt-1 text-xs text-[var(--ink-500)]">{automationResult.body?.data?automaticModeStatusText(automationResult.body.data,en):(en?'Reception status unavailable; refresh to verify.':'接待状态暂不可用，请刷新核实。')}</p></div>
        <div className="flex items-center gap-2"><WorkbenchPushPrompt key={`${workspace.tenant_id}:${session.user.id}`} en={en} tenantId={workspace.tenant_id} userId={session.user.id}/><a href={workbenchHref({conversation:selectedId ?? null})} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs font-semibold"><RefreshCw size={14}/>{en ? "Refresh" : "刷新"}</a></div>
      </div>

      <div className="studio-grid grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_280px]">
        <section className={`${selectedId ? "hidden lg:flex" : "flex"} min-h-0 min-w-0 overflow-hidden flex-col border-r border-[var(--border-subtle)] bg-white`} aria-label={en ? "Conversation list" : "会话列表"}>
          <div className="shrink-0 border-b border-[var(--border-subtle)] p-3">
            <div className="grid grid-cols-4 gap-1 rounded-xl bg-slate-100 p-1">{(["all", "open", "pending", "resolved"] as const).map(item => <a key={item} href={workbenchHref({status:item,cursor:null})} className={`rounded-lg px-1 py-2 text-center text-[11px] font-semibold ${status === item ? "bg-white text-[var(--brand-700)] shadow-sm" : "text-[var(--ink-500)]"}`}>{item === "all" ? (en ? "All" : "全部") : item === "open" ? (en ? "Open" : "待处理") : item === "pending" ? (en ? "Pending" : "等待中") : (en ? "Resolved" : "已解决")}</a>)}</div>
          </div>
          <div className="shrink-0 px-3 pb-2"><ConversationSearch en={en} status={status} values={query}/></div>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
            {listResult.status !== 200 && <Empty icon={<Inbox/>} title={listState === 'setup_error' ? (en ? 'Conversation access needs attention' : '会话服务访问配置异常') : listState === 'forbidden' ? (en ? 'Access restricted' : '暂无会话访问权限') : listState === 'invalid_search' ? (en ? 'Invalid search' : '筛选条件无效') : (en ? "Conversations unavailable" : "会话暂不可用")} detail={listState === 'setup_error' ? (en ? 'Please contact platform support to check workspace access.' : '请联系平台支持检查企业工作区关联，不需要重新注册。') : listState === 'forbidden' ? (en ? 'Please contact your company administrator.' : '请联系企业管理员检查权限。') : listState === 'invalid_search' ? (en ? 'Please reset your filters and try again.' : '请重置筛选条件后重试。') : (en ? 'Please retry later. If this persists, contact platform support.' : '请稍后刷新重试；若持续出现，请联系平台支持。')}/>}
            {listResult.status === 200 && conversations.length === 0 && (listState === 'no_channels' ? <><Empty icon={<Inbox/>} title={en ? 'No channel connected' : '未接入渠道'} detail={workspace.role === 'tenant_admin' ? (en ? 'Connect Web Chat or WeChat to start receiving customer conversations.' : '接入网站聊天或微信公众号后，即可接待客户咨询。') : (en ? 'Ask your company administrator to connect a customer channel.' : '请联系企业管理员接入客户渠道。')}/>{workspace.role === 'tenant_admin' && <p className="px-4 pb-8 text-center"><a href="/channels" className="inline-flex rounded-xl bg-[var(--brand-500)] px-4 py-2 text-sm font-semibold text-white">{en ? 'Connect a channel' : '前往接入渠道'}</a></p>}</> : <Empty icon={<CheckCircle2/>} title={en ? "No conversations here" : "这里暂无会话"} detail={en ? "Try another status filter." : "可以切换其他状态查看。"}/>)}
            {conversations.map(item => <a key={item.id} href={workbenchHref({conversation:item.id})} className={`studio-conversation block border-b border-[var(--border-subtle)] p-4 transition hover:bg-slate-50 ${selectedId === item.id ? "bg-blue-50/70" : ""}`}>
              <div className="flex items-start gap-3"><CustomerAvatar name={item.contact?.display_name} url={item.contact?.avatar_url} en={en}/><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><p className="truncate text-sm font-semibold">{item.contact?.display_name ?? (en ? "Unknown customer" : "未知客户")}</p><span className="shrink-0 text-[11px] text-[var(--ink-500)]">{dateTime(item.last_activity_at, en)}</span></div><p className="mt-1 truncate text-xs text-[var(--ink-500)]">{item.last_message?.text || (item.last_message?.attachments.length ? (en ? "Attachment" : "附件消息") : (en ? "No message preview" : "暂无消息摘要"))}</p><div className="mt-2 flex items-center gap-2"><Status value={item.status} en={en}/><UnreadBadge tenantId={workspace.tenant_id} conversationId={item.id} count={item.unread_count} capped={item.unread_capped} available={item.unread_available} en={en}/>{item.priority && <span className="text-[10px] text-amber-700">{item.priority}</span>}</div></div><ChevronRight className="mt-3 shrink-0 text-slate-300" size={16}/></div>
            </a>)}
          </div>
          {listResult.body?.pagination.next_cursor && <p className="shrink-0 border-t border-[var(--border-subtle)] p-3 text-center text-xs text-[var(--ink-500)]"><a href={workbenchHref({cursor:listResult.body.pagination.next_cursor})}>{en ? "Continue to older results →" : "继续查找更早的会话 →"}</a></p>}
        </section>

        <section className={`${selectedId ? "flex" : "hidden lg:flex"} min-h-0 min-w-0 flex-col bg-slate-50`} aria-label={en ? "Message thread" : "消息流"}>
          {!selectedId && <Empty icon={<MessageCircleMore/>} title={en ? "Select a conversation" : "选择一条会话"} detail={en ? "Messages and safe attachments will appear here." : "这里将展示消息与受控附件。"}/>}
          {selectedId && !selected && <div className="flex h-full items-center justify-center p-6"><Empty icon={<MessageCircleMore/>} title={en ? "Conversation unavailable" : "会话不可用"} detail={en ? "It may have been removed or is outside this workspace." : "会话可能已删除，或不属于当前企业。"}/></div>}
          {selected && <><div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] bg-white px-3 py-2"><a href={workbenchHref()} className="grid size-9 shrink-0 place-items-center rounded-lg border border-[var(--border-subtle)] lg:hidden" aria-label={en ? "Back" : "返回"}><ArrowLeft size={17}/></a><CustomerAvatar name={selected.contact?.display_name} url={selected.contact?.avatar_url} en={en}/><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{selected.contact?.display_name ?? (en ? "Unknown customer" : "未知客户")}</p><p className="mt-0.5 truncate text-xs text-[var(--ink-500)]">{workbenchChannel(selected.contact?.channel,en)} · {selected.assignment?.display_name ?? (en ? "Unassigned" : "未分配")}</p></div><Status value={selected.status} en={en}/><CustomerDetailsButton en={en}/></div>
            <ConversationActions conversationId={selected.id} status={selected.status} assigneeId={selected.assignment?.member_id ?? null} actorId={session.user.id} role={workspace.role} assignees={assignees} en={en}/>
            <WorkbenchReadReceipt key={`${workspace.tenant_id}:${selected.id}`} tenantId={workspace.tenant_id} conversationId={selected.id} enabled={listResult.body?.read_receipts_enabled===true&&!session.impersonation} en={en}><div className="mx-auto max-w-3xl space-y-4">{messages.length === 0 && <Empty icon={<MessageCircleMore/>} title={en ? "No messages" : "暂无消息"} detail={en ? "The conversation does not contain visible messages." : "当前会话中没有可展示的消息。"}/>} {messages.map(message => <MessageBubble key={message.id} message={message} en={en} customerName={selected.contact?.display_name}/>)}</div></WorkbenchReadReceipt>
            <ReplyComposer key={selected.id} conversationId={selected.id} canReply={selected.can_reply} role={workspace.role} en={en} channel={selected.contact?.channel} initialQuestion={latestCustomerQuestion}/></>}
        </section>

        <CustomerDetailsPanel en={en}>
          {selected&&<div className="studio-tools mb-4"><WorkbenchTools key={selected.id} conversationId={selected.id}/></div>}
          {selected&&process.env.CONSOLE_CUSTOMER_INSIGHTS_ENABLED==='true'&&!session.impersonation&&<CustomerInsightsProfile key={`${workspace.tenant_id}:${selected.id}`} workspaceId={workspace.tenant_id} conversationId={selected.id}/>}
{!selected ? <Empty icon={<UserRound/>} title={en ? "No conversation selected" : "尚未选择会话"} detail={en ? "Customer and assignment details appear here." : "选择会话后展示客户与分配信息。"}/> : <div className="space-y-6"><CustomerProfileEditor key={selected.id} conversationId={selected.id} en={en}/><div><p className="text-xs font-semibold uppercase tracking-wider text-[var(--ink-500)]">{en ? "Customer" : "客户"}</p><p className="mt-2 font-semibold">{selected.contact?.display_name ?? (en ? "Unknown customer" : "未知客户")}</p><p className="mt-1 text-xs text-[var(--ink-500)]">{workbenchChannel(selected.contact?.channel,en)}</p></div><Detail label={en ? "Assigned to" : "当前负责人"} value={selected.assignment?.display_name ?? (en ? "Unassigned" : "未分配")}/><Detail label={en ? "Waiting since" : "等待开始"} value={dateTime(selected.waiting_since, en)}/><Detail label={en ? "Last activity" : "最后活动"} value={dateTime(selected.last_activity_at, en)}/><div><p className="text-xs font-semibold text-[var(--ink-500)]">{en ? "Labels" : "标签"}</p><div className="mt-2 flex flex-wrap gap-2">{selected.labels.length ? selected.labels.map(label => <span key={label} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs">{label}</span>) : <span className="text-sm text-[var(--ink-500)]">—</span>}</div></div><TransferList items={fileTransfers} en={en}/></div>}
          <WorkbenchAutomationStatus settings={automationResult.body?.data} channel={selected?.contact?.channel} humanAssigned={!!selected?.assignment} canManage={workspace.role==="tenant_admin"&&!session.impersonation} en={en} conversationId={selected?.id} tenantId={workspace.tenant_id}/>
        </CustomerDetailsPanel>
      </div>
    </main></CustomerDetailsProvider>
  </WorkbenchShell>;
}

function Status({ value, en }: { value: Conversation["status"]; en: boolean }) {
  const copy = { open: en ? "Open" : "待处理", pending: en ? "Pending" : "等待中", resolved: en ? "Resolved" : "已解决", snoozed: en ? "Snoozed" : "已稍后", unknown: en ? "Unknown" : "未知" }[value];
  const tone = value === "resolved" ? "bg-green-50 text-green-700" : value === "open" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600";
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone}`}>{copy}</span>;
}
function Detail({ label, value }: { label: string; value: string }) { return <div><p className="text-xs font-semibold text-[var(--ink-500)]">{label}</p><p className="mt-1 text-sm">{value}</p></div>; }
function TransferList({ items, en }: { items: FileTransfer[]; en: boolean }) {
  if (!items.length) return null;
  return <div><p className="text-xs font-semibold text-[var(--ink-500)]">{en ? "Secure file transfers" : "安全文件中转"}</p><div className="mt-2 space-y-2">{items.slice(0, 8).map(item => <div key={item.transfer_id} className="rounded-xl border border-[var(--border-subtle)] bg-slate-50 p-3"><div className="flex items-start gap-2"><Paperclip className="mt-0.5 shrink-0 text-slate-500" size={14}/><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold">{item.file_name ?? (item.direction === "inbound_upload" ? (en ? "Customer upload invitation" : "客户上传邀请") : (en ? "Shared file" : "共享文件"))}</p><p className="mt-1 text-[10px] text-[var(--ink-500)]">{workbenchTransfer(item.status,en)} · {dateTime(item.created_at, en)}</p></div>{item.status === "ready" && <a href={`/api/file-transfers/${item.transfer_id}/content`} title={en ? "Download" : "下载"} className="text-[var(--brand-700)]"><Download size={14}/></a>}</div></div>)}</div></div>;
}
function Empty({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) { return <div className="m-auto max-w-sm p-8 text-center text-[var(--ink-500)]"><div className="mx-auto grid size-12 place-items-center rounded-2xl bg-slate-100">{icon}</div><h2 className="mt-3 font-semibold text-[var(--ink-900)]">{title}</h2><p className="mt-1 text-xs leading-5">{detail}</p></div>; }

function MessageBubble({ message, en, customerName }: { message: Message; en: boolean; customerName?:string }) {
  const sharedLabels:Record<string,string>={shared_provider_accepted:en?"WeChat accepted · not a read receipt":"微信已接受 · 不代表已读",shared_pending:en?"Delivery not confirmed":"投递尚未确认",shared_uncertain:en?"Needs reconciliation · do not resend":"结果待核对 · 请勿重发",shared_blocked:en?"WeChat delivery blocked":"微信投递被阻止"};
  message={...message,delivery_status:wechatDeliveryFailure(message.delivery_status??"",en)??sharedLabels[message.delivery_status??""]??(message.delivery_status?workbenchDelivery(message.delivery_status,en):null)};
  if (message.direction === "activity") return <div className="flex justify-center"><div data-conversation-activity className="studio-activity max-w-full rounded-xl px-3 py-1.5 text-center text-[11px] leading-5 [overflow-wrap:anywhere]">{conversationActivity(message.text,en)} · {dateTime(message.created_at, en)}</div></div>;
  const outgoing = message.direction === "outgoing";
  if(message.direction==='incoming'&&customerName)message={...message,sender:{...message.sender,display_name:customerName}};
  return <article data-incoming-message-id={message.direction==='incoming'&&!message.private?message.id:undefined} className={`flex ${outgoing ? "justify-end" : "justify-start"}`}><div className={`max-w-[88%] md:max-w-[72%] ${outgoing ? "items-end" : "items-start"}`}><div className={`rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm ${message.private ? "border border-amber-200 bg-amber-100 text-amber-950" : outgoing ? "rounded-br-md bg-[var(--brand-500)] text-white" : "rounded-bl-md border border-[var(--border-subtle)] bg-white text-[var(--ink-900)]"}`}>
    {message.private && <p className="mb-1 text-[11px] font-semibold">{en ? "Private note · Team only" : "私人便笺 · 仅团队可见"}</p>}
    {message.text && <p className="whitespace-pre-wrap break-words">{message.text}</p>}
    {message.attachments.length > 0 && <div className={`${message.text ? "mt-3" : ""} space-y-2`}>{message.attachments.map(attachment => <AttachmentView key={attachment.id} attachment={attachment} en={en} outgoing={outgoing&&!message.private}/>)}</div>}
  </div><div className={`mt-1 flex items-center gap-1.5 px-1 text-[10px] text-[var(--ink-500)] ${outgoing ? "justify-end" : "justify-start"}`}><Clock3 size={11}/><span>{message.sender.display_name ?? (outgoing ? (en ? "Agent" : "坐席") : (en ? "Customer" : "客户"))} · {dateTime(message.created_at, en)}</span>{outgoing && !message.private && message.delivery_status && <span>· {message.delivery_status}</span>}</div></div></article>;
}

function AttachmentView({ attachment, en, outgoing }: { attachment: Attachment; en: boolean; outgoing: boolean }) {
  if(!attachment.download_available)return <div className="rounded-xl bg-slate-100 p-3 text-xs text-slate-600">{attachment.file_name??(en?'Media':'媒体')} · {attachment.processing_status==='failed'?(en?'Processing failed; ask the customer to resend.':'媒体处理失败，请客户重新发送。'):attachment.processing_status==='expired'?(en?'Media expired':'媒体已过期'):(en?'Being scanned. Refresh shortly.':'正在安全处理媒体，请稍后刷新。')}</div>;
  const href = `/api/attachments/${attachment.id}/content`;
  const preview = attachment.content_type?.startsWith("image/") && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(attachment.content_type);
  return <div className={`overflow-hidden rounded-xl ${outgoing ? "bg-black/10" : "bg-slate-50"}`}>{attachment.content_type==='video/mp4'&&<video controls preload="none" src={`${href}?disposition=inline`} className="max-h-72 w-full"/>}{['audio/mpeg','audio/ogg'].includes(attachment.content_type??'')&&<audio controls preload="none" src={`${href}?disposition=inline`} className="max-w-full"/>}{['audio/amr','audio/speex'].includes(attachment.content_type??'')&&<p className="p-3 text-xs">{en?'AMR / Speex voice: download to play in a compatible player.':'微信 AMR / Speex 语音：请下载后使用兼容播放器收听。'}</p>}{preview && <a href={`${href}?disposition=inline`} target="_blank" rel="noreferrer"><img src={`${href}?disposition=inline`} alt={attachment.file_name ?? (en ? "Conversation attachment" : "会话图片附件")} loading="lazy" className="max-h-72 w-full object-contain"/></a>}<a href={href} className="flex items-center gap-3 p-3"><span className={`grid size-9 shrink-0 place-items-center rounded-lg ${outgoing ? "bg-white/15" : "bg-white"}`}>{preview ? <ImageIcon size={17}/> : attachment.content_type === "application/pdf" ? <FileText size={17}/> : <Paperclip size={17}/>}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold">{attachment.file_name ?? (en ? "Attachment" : "附件")}</span><span className={`mt-0.5 block text-[10px] ${outgoing ? "text-blue-100" : "text-[var(--ink-500)]"}`}>{fileSize(attachment.size_bytes, en)}</span></span><Download size={15}/></a></div>;
}
