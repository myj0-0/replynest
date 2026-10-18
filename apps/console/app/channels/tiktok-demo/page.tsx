import { ConsolePageHeading } from "../../../components/console-page-heading";
import { ArrowLeft, Bot, CheckCircle2, CircleDashed, MessageCircleMore, RadioTower, ShieldCheck, Video } from "lucide-react";
import { redirect } from "next/navigation";
import { ConsoleShell } from "../../../components/console-shell";
import { getConsoleLocale } from "../../../lib/console-locale-server";
import { fetchConsoleSession, gatewayUrl, sessionToken } from "../../../lib/console-session";

export const dynamic = "force-dynamic";

type DemoEvent = {
  social_event_id: string;
  event_type: "dm.message" | "comment.created";
  content: string;
  occurred_at: string;
  category: string;
  confidence: number;
  source: string;
  reason_codes: string[];
  route: string;
  priority: string;
  requires_human: boolean;
  action_gate?: { allowed?: boolean; execution_mode?: string; reason_codes?: string[] };
};

type DemoData = {
  enabled: boolean;
  disclosure: { prototype: boolean; synthetic_data: boolean; network_calls: number; provider_writes: number; live_authorization: boolean; automatic_send: boolean };
  connection: null | { connection_id: string; display_name: string; status: string; capability_snapshot: Record<string, boolean> };
  events: DemoEvent[];
  samples: Record<"dm.message" | "comment.created", string[]>;
};

const categories: Record<string, { zh: string; en: string }> = {
  spam: { zh: "垃圾信息", en: "Spam" }, generic_interaction: { zh: "普通互动", en: "Generic interaction" },
  purchase_intent: { zh: "购买意向", en: "Purchase intent" }, pre_sale_question: { zh: "售前咨询", en: "Pre-sale question" },
  after_sales: { zh: "售后", en: "After-sales" }, complaint_risk: { zh: "投诉风险", en: "Complaint risk" },
  public_crisis: { zh: "舆情风险", en: "Public crisis" }, unknown: { zh: "待判断", en: "Needs review" },
};

export default async function TikTokReviewDemoPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const session = await fetchConsoleSession();
  const token = await sessionToken();
  if (!session || !token) redirect("/login?error=expired");
  const workspace = session.workspaces.find((item) => item.tenant_id === session.selected_tenant_id);
  if (!workspace) redirect("/workspaces");
  const locale = await getConsoleLocale();
  const en = locale === "en";
  const response = await fetch(gatewayUrl("/api/v1/social/demo/tiktok"), { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (response.status === 401) redirect("/login?error=expired");
  const data = response.ok ? (await response.json() as { data: DemoData }).data : undefined;
  const params = await searchParams;
  const steps = [
    { title: en ? "Simulated account authorization" : "模拟账号授权", detail: en ? "Creates a prototype connection without an access token." : "不使用 Access Token，只创建原型连接。", icon: ShieldCheck, done: Boolean(data?.connection) },
    { title: en ? "Simulated webhook subscription" : "模拟 Webhook 订阅", detail: en ? "The fixture produces normalized DM and comment events." : "测试夹具生成标准化私信与评论事件。", icon: RadioTower, done: Boolean(data?.connection) },
    { title: en ? "Classify and route" : "分类与路由", detail: en ? "Business rules and deterministic signals select the human workflow." : "企业规则和确定性信号决定人工处理流程。", icon: Bot, done: Boolean(data?.events.length) },
    { title: en ? "Human confirmation" : "人工确认", detail: en ? "No comment, message or DM is sent automatically." : "不会自动回复评论、发送消息或私信。", icon: MessageCircleMore, done: Boolean(data?.events.length) },
  ];
  const dmSample = data?.samples["dm.message"]?.[0] ?? "Hi, I need help choosing the right plan for three TikTok accounts.";
  const commentSamples = data?.samples["comment.created"] ?? ["Can I buy this in bulk? Please send me the purchase details."];

  return <ConsoleShell session={session} workspace={workspace} activePath="/channels" statusPageUrl={process.env.STATUS_PUBLIC_URL ?? "http://localhost:3300"}>
    <main lang={en ? "en" : "zh-CN"} className="mx-auto min-h-screen max-w-5xl p-4 md:p-8">
      <a href="/channels" className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--brand-700)]"><ArrowLeft size={16}/>{en ? "Back to channels" : "返回渠道与接入"}</a>
      <div className="mt-5 flex flex-col gap-4 md:flex-row md:items-start md:justify-between"><div><ConsolePageHeading icon="channels">{en ? "Business Messaging and comment workflow" : "私信与评论处理演示"}</ConsolePageHeading><p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--ink-500)]">{en ? "A recordable, end-to-end prototype for the TikTok access application. It demonstrates planned authorization, webhook ingestion, classification and human handling without contacting TikTok." : "用于 TikTok 权限申请录屏的端到端原型，演示计划中的授权、Webhook 入站、分类和人工处理流程，但不会连接 TikTok。"}</p><a href="/channels/tiktok-demo/presentation?step=1" className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-[var(--brand-700)]">{en ? "Open privacy-safe presentation mode" : "打开隐私安全录屏模式"}<ArrowLeft className="rotate-180" size={15}/></a></div><span className="self-start rounded-full bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-700">{en ? "PROTOTYPE · SYNTHETIC DATA" : "原型 · 合成数据"}</span></div>

      {params.result === "initialized" && <Notice>{en ? "The simulated authorization and webhook subscription are ready." : "模拟授权和 Webhook 订阅已就绪。"}</Notice>}
      {params.result === "event_created" && <Notice>{en ? "A synthetic event was classified and routed. No TikTok network call was made." : "合成事件已完成分类和路由，未调用 TikTok 网络。"}</Notice>}
      {params.result === "failed" && <div role="alert" className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{en ? "The prototype action failed. Confirm that review-demo mode is enabled and that you are a workspace administrator." : "原型操作失败。请确认审核演示模式已启用，且当前账号为企业管理员。"}</div>}

      <section className="mt-6 rounded-2xl border border-violet-200 bg-violet-50/40 p-5"><h2 className="font-semibold text-violet-900">{en ? "Review disclosure" : "审核演示声明"}</h2><p className="mt-2 text-sm leading-6 text-violet-900/80">{en ? "This is a product prototype using synthetic users and events. Network calls: 0 · provider writes: 0 · live authorization: off · automatic send: off. It must not be presented as an approved or live TikTok integration." : "这是使用合成用户和事件的产品原型。网络调用：0 · 平台写入：0 · 真实授权：关闭 · 自动发送：关闭。录屏时不得表述为已获批或已上线的 TikTok 接入。"}</p></section>

      <section className="mt-5 grid gap-3 md:grid-cols-2">{steps.map(({ title, detail, icon: Icon, done }) => <article key={title} className="flex gap-3 rounded-2xl border border-[var(--border-subtle)] bg-white p-4 shadow-sm"><div className={`grid size-10 shrink-0 place-items-center rounded-xl ${done ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}><Icon size={19}/></div><div><div className="flex items-center gap-2 text-sm font-semibold">{title}{done ? <CheckCircle2 size={15} className="text-emerald-600"/> : <CircleDashed size={15}/>}</div><p className="mt-1 text-xs leading-5 text-[var(--ink-500)]">{detail}</p></div></article>)}</section>

      {!data?.enabled && <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{en ? "The server-side review-demo switch is off." : "服务端审核演示开关尚未启用。"}</div>}
      {workspace.role === "tenant_admin" && !data?.connection && <form action="/api/social/demo/tiktok/session" method="post" className="mt-5"><button disabled={!data?.enabled} className="rounded-xl bg-[var(--brand-500)] px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{en ? "Start simulated authorization" : "开始模拟授权"}</button></form>}

      {data?.connection && <section className="mt-6 rounded-2xl border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)] md:p-6"><div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold">{en ? "Inject a synthetic webhook event" : "注入合成 Webhook 事件"}</h2><p className="mt-1 text-xs text-[var(--ink-500)]">{en ? "Choose an example or edit the text before submitting." : "可以选择示例，也可以编辑文本后提交。"}</p></div><span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">{en ? "Simulated connection ready" : "模拟连接已就绪"}</span></div>
        <div className="mt-5 grid gap-4 lg:grid-cols-2"><DemoForm en={en} eventType="dm.message" sample={dmSample}/><DemoForm en={en} eventType="comment.created" sample={commentSamples[0]}/></div>
        <div className="mt-4 flex flex-wrap gap-2">{commentSamples.slice(1).map((sample) => <span key={sample} className="rounded-full bg-slate-100 px-3 py-1.5 text-xs text-slate-600">{sample}</span>)}</div>
      </section>}

      <section className="mt-6 rounded-2xl border border-[var(--border-subtle)] bg-white p-5 shadow-[var(--shadow-card)] md:p-6"><div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold">{en ? "Classification and human-routing results" : "分类与人工路由结果"}</h2><p className="mt-1 text-xs text-[var(--ink-500)]">{en ? "Most recent synthetic events are shown first." : "最近的合成事件显示在最前。"}</p></div><span className="text-xs font-semibold text-[var(--ink-500)]">{data?.events.length ?? 0} {en ? "events" : "条事件"}</span></div>
        {!data?.events.length ? <p className="mt-4 rounded-xl bg-slate-50 p-5 text-sm text-[var(--ink-500)]">{en ? "No demo event yet. Initialize the prototype and inject a DM or comment." : "暂无演示事件，请先初始化原型并注入私信或评论。"}</p> : <div className="mt-4 space-y-3">{data.events.map((event) => <article key={event.social_event_id} className="rounded-xl border border-[var(--border-subtle)] p-4"><div className="flex flex-wrap gap-2"><Badge>{event.event_type === "dm.message" ? (en ? "Direct message" : "私信") : (en ? "Comment" : "评论")}</Badge><Badge>{categories[event.category]?.[locale] ?? event.category}</Badge><Badge>{en ? `Confidence ${Math.round(Number(event.confidence) * 100)}%` : `置信度 ${Math.round(Number(event.confidence) * 100)}%`}</Badge><Badge>{event.route}</Badge></div><p className="mt-3 text-sm leading-6 text-slate-800">{event.content}</p><div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600"><p><b>{en ? "Human handling:" : "人工处理："}</b> {event.requires_human ? (en ? "required" : "需要") : (en ? "not required" : "无需")}</p><p><b>{en ? "Comment-to-DM gate:" : "评论转私信门禁："}</b> {event.action_gate?.allowed ? (en ? "eligible, but still requires human confirmation" : "满足条件，但仍需人工确认") : (en ? "not eligible / not applicable" : "不满足或不适用")}</p><p><b>{en ? "Automatic send:" : "自动发送："}</b> {en ? "disabled" : "关闭"}</p></div></article>)}</div>}
      </section>
    </main>
  </ConsoleShell>;
}

function DemoForm({ en, eventType, sample }: { en: boolean; eventType: "dm.message" | "comment.created"; sample: string }) {
  const isDm = eventType === "dm.message";
  return <form action="/api/social/demo/tiktok/events" method="post" className="rounded-xl border border-[var(--border-subtle)] p-4"><input type="hidden" name="event_type" value={eventType}/><label className="text-sm font-semibold">{isDm ? (en ? "Incoming direct message" : "入站私信") : (en ? "High-value comment" : "高价值评论")}<textarea name="content" required minLength={1} maxLength={1000} defaultValue={sample} className="mt-3 min-h-28 w-full rounded-xl border border-[var(--border-subtle)] p-3 text-sm leading-6"/></label><button className="mt-3 w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white">{en ? "Simulate webhook event" : "模拟 Webhook 事件"}</button></form>;
}

function Badge({ children }: { children: React.ReactNode }) { return <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">{children}</span>; }
function Notice({ children }: { children: React.ReactNode }) { return <div role="status" className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{children}</div>; }
