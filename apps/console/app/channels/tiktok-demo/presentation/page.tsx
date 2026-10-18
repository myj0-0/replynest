import Image from "next/image";
import { ArrowRight, Bot, Check, LockKeyhole, MessageCircleMore, RadioTower, ShieldCheck, Sparkles, UserCheck } from "lucide-react";
import { redirect } from "next/navigation";
import { fetchConsoleSession, gatewayUrl, sessionToken } from "../../../../lib/console-session";

export const dynamic = "force-dynamic";

type ReviewEvent = {
  social_event_id: string;
  event_type: "dm.message" | "comment.created";
  content: string;
  category: string;
  confidence: number;
  route: string;
  priority: string;
  requires_human: boolean;
  action_gate?: { allowed?: boolean; execution_mode?: string };
};

type ReviewData = {
  connection: null | { status: string; capability_snapshot: Record<string, boolean> };
  events: ReviewEvent[];
};

const stages = ["Overview", "Authorization", "Webhook event", "AI classification", "Human workflow"];

export default async function TikTokPresentationPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const session = await fetchConsoleSession();
  const token = await sessionToken();
  if (!session || !token) redirect("/login?error=expired");
  const workspace = session.workspaces.find((item) => item.tenant_id === session.selected_tenant_id);
  if (!workspace) redirect("/workspaces");

  const response = await fetch(gatewayUrl("/api/v1/social/demo/tiktok"), {
    headers: { authorization: `Bearer ${token}` }, cache: "no-store",
  });
  if (response.status === 401) redirect("/login?error=expired");
  const data = response.ok ? (await response.json() as { data: ReviewData }).data : undefined;
  const requested = Number((await searchParams).step ?? 1);
  const step = Number.isInteger(requested) ? Math.min(5, Math.max(1, requested)) : 1;
  const event = data?.events.find((item) => item.category === "purchase_intent") ?? data?.events[0];

  return <main lang="en" className="min-h-screen overflow-hidden bg-[#071426] text-white">
    <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_75%_10%,rgba(23,146,255,.28),transparent_32%),radial-gradient(circle_at_10%_90%,rgba(129,92,246,.22),transparent_34%)]"/>
    <div className="relative mx-auto flex min-h-screen max-w-[1440px] flex-col px-10 py-7 lg:px-16">
      <header className="flex items-center justify-between border-b border-white/10 pb-5">
        <div className="flex items-center gap-3"><span className="relative block size-11 overflow-hidden rounded-xl bg-white"><Image src="/replynest-mark.png" alt="ReplyNest" fill priority sizes="44px" className="scale-125 object-contain"/></span><div><p className="text-xl font-bold tracking-tight">ReplyNest</p><p className="text-xs text-slate-400">TikTok API Review Prototype</p></div></div>
        <div className="flex items-center gap-2 rounded-full border border-violet-300/30 bg-violet-400/10 px-4 py-2 text-xs font-semibold text-violet-200"><ShieldCheck size={15}/> PROTOTYPE · SYNTHETIC DATA</div>
      </header>

      <section className="flex flex-1 flex-col justify-center py-6">
        {step === 1 && <Overview/>}
        {step === 2 && <Authorization ready={Boolean(data?.connection)}/>}
        {step === 3 && <WebhookEvent event={event}/>}
        {step === 4 && <Classification event={event}/>}
        {step === 5 && <HumanWorkflow event={event}/>}
      </section>

      <footer className="flex items-end justify-between gap-8 border-t border-white/10 pt-5">
        <div className="flex gap-2">{stages.map((label, index) => <div key={label} className="flex items-center gap-2"><span className={`grid size-7 place-items-center rounded-full text-xs font-bold ${index + 1 <= step ? "bg-blue-500 text-white" : "bg-white/10 text-slate-500"}`}>{index + 1 < step ? <Check size={14}/> : index + 1}</span><span className={`hidden text-xs xl:inline ${index + 1 === step ? "font-semibold text-white" : "text-slate-500"}`}>{label}</span>{index < stages.length - 1 && <span className="mx-1 h-px w-5 bg-white/10"/>}</div>)}</div>
        <div className="text-right text-[11px] leading-5 text-slate-400"><p>Network calls: <b className="text-emerald-300">0</b> · Provider writes: <b className="text-emerald-300">0</b></p><p>Live authorization: OFF · Automatic send: OFF</p></div>
      </footer>
    </div>
  </main>;
}

function Overview() { return <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_.95fr]"><div><Pill icon={<Sparkles size={15}/>}>Product walkthrough</Pill><h1 className="mt-5 max-w-3xl text-5xl font-bold leading-[1.08] tracking-tight lg:text-6xl">Turn TikTok conversations into <span className="text-blue-400">human-ready service work.</span></h1><p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300">ReplyNest demonstrates the planned Business Messaging and comment workflow—from webhook ingestion to classification and safe human handling.</p></div><div className="grid gap-4"><FlowCard icon={<MessageCircleMore/>} title="Direct messages" text="Bring customer conversations into one service workflow."/><FlowCard icon={<Bot/>} title="Comment intelligence" text="Filter noise and identify purchase, support and complaint intent."/><FlowCard icon={<UserCheck/>} title="Human-first actions" text="Require an agent decision before any reply or private message."/></div></div>; }

function Authorization({ ready }: { ready: boolean }) { return <div><SectionTitle eyebrow="Step 1 · Authorization" title="Connect a TikTok Business account" subtitle="The prototype demonstrates the planned OAuth and capability handshake without requesting a real access token."/><div className="mt-8 grid gap-5 lg:grid-cols-3"><StatusCard icon={<LockKeyhole/>} title="OAuth authorization" status={ready ? "Simulated" : "Prototype"} text="Account consent and workspace binding."/><StatusCard icon={<RadioTower/>} title="Webhook subscription" status={ready ? "Ready" : "Prototype"} text="Direct message and comment event topics."/><StatusCard icon={<ShieldCheck/>} title="Capability snapshot" status="Checked" text="Messaging, comments and comment-to-DM gates."/></div><div className="mt-6 rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-5 text-sm text-emerald-100"><b>No credentials are collected in this review mode.</b> The connection is synthetic and cannot contact TikTok.</div></div>; }

function WebhookEvent({ event }: { event?: ReviewEvent }) { const content = event?.content ?? "Can I buy this in bulk? Please send me the purchase details."; return <div><SectionTitle eyebrow="Step 2 · Webhook ingestion" title="A high-value comment arrives" subtitle="ReplyNest normalizes the provider event, applies tenant isolation and keeps the original customer text as untrusted input."/><div className="mt-8 grid items-stretch gap-6 lg:grid-cols-[.85fr_1.15fr]"><div className="rounded-3xl border border-white/10 bg-white/[.06] p-6"><p className="text-xs font-semibold uppercase tracking-[.2em] text-slate-400">Synthetic TikTok event</p><div className="mt-5 flex items-center gap-3"><span className="grid size-12 place-items-center rounded-full bg-slate-700 text-lg font-bold">TT</span><div><p className="font-semibold">Demo customer</p><p className="text-xs text-slate-400">Comment · just now</p></div></div><p className="mt-6 rounded-2xl bg-white p-5 text-lg leading-8 text-slate-900">“{content}”</p></div><div className="grid gap-3"><PipelineRow number="01" title="Verify and deduplicate" text="Reject replays and conflicting event facts."/><PipelineRow number="02" title="Normalize safely" text="Map the comment into a provider-neutral social event."/><PipelineRow number="03" title="Evaluate business intent" text="Rules and deterministic signals run before any action."/></div></div></div>; }

function Classification({ event }: { event?: ReviewEvent }) { const confidence = Math.round(Number(event?.confidence ?? .88) * 100); return <div><SectionTitle eyebrow="Step 3 · Classification" title="Separate signal from social noise" subtitle="Business rules and deterministic signals classify the event. Historical conversations may inform tone, but never become policy automatically."/><div className="mt-8 grid gap-5 lg:grid-cols-[1fr_1fr]"><div className="rounded-3xl border border-blue-400/30 bg-blue-500/10 p-7"><div className="flex items-center justify-between"><Pill icon={<Sparkles size={15}/>}>Classification result</Pill><span className="rounded-full bg-emerald-400/15 px-3 py-1 text-xs font-bold text-emerald-300">{confidence}% confidence</span></div><p className="mt-7 text-4xl font-bold">Purchase intent</p><p className="mt-3 text-slate-300">The customer is asking for buying details and should enter the sales-support workflow.</p><div className="mt-7 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-300" style={{ width: `${confidence}%` }}/></div></div><div className="grid gap-4"><Decision title="Spam or generic interaction" value="No case created" muted/><Decision title="Purchase or pre-sale intent" value="Create human case" active/><Decision title="Complaint or public crisis" value="Escalate immediately"/></div></div></div>; }

function HumanWorkflow({ event }: { event?: ReviewEvent }) { return <div><SectionTitle eyebrow="Step 4 · Human workflow" title="Recommend the next action—never auto-send" subtitle="The event is routed into the service workflow with its evidence, confidence and safety gates visible to the agent."/><div className="mt-8 grid gap-5 lg:grid-cols-[1.1fr_.9fr]"><div className="rounded-3xl border border-white/10 bg-white/[.06] p-7"><div className="flex items-center justify-between"><div><p className="text-xs font-semibold uppercase tracking-[.2em] text-slate-400">Human service case</p><h3 className="mt-2 text-2xl font-bold">TikTok purchase inquiry</h3></div><span className="rounded-full bg-amber-300/15 px-3 py-1.5 text-xs font-bold text-amber-200">Human action required</span></div><p className="mt-6 rounded-2xl bg-slate-950/50 p-5 text-base leading-7 text-slate-200">{event?.content ?? "Can I buy this in bulk? Please send me the purchase details."}</p><div className="mt-5 flex flex-wrap gap-2"><Tag>Purchase intent</Tag><Tag>{Math.round(Number(event?.confidence ?? .88) * 100)}% confidence</Tag><Tag>{event?.route ?? "chatwoot_case"}</Tag></div></div><div className="grid gap-3"><Gate ok title="Agent review" text="Required before any customer-facing action."/><Gate ok title="Evidence visible" text="Classification and policy basis travel with the case."/><Gate title="Automatic reply" text="Disabled until tenant controls and calibrated thresholds are approved."/></div></div><div className="mt-6 flex items-center justify-between rounded-2xl border border-blue-400/25 bg-blue-500/10 px-6 py-4"><p className="font-semibold text-blue-100">Ready for safe agent handling</p><span className="flex items-center gap-2 text-sm font-semibold text-blue-300">Open in customer service workspace <ArrowRight size={17}/></span></div></div>; }

function SectionTitle({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) { return <div><p className="text-sm font-bold uppercase tracking-[.18em] text-blue-400">{eyebrow}</p><h1 className="mt-3 text-4xl font-bold tracking-tight lg:text-5xl">{title}</h1><p className="mt-4 max-w-4xl text-lg leading-8 text-slate-300">{subtitle}</p></div>; }
function Pill({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) { return <span className="inline-flex items-center gap-2 rounded-full border border-blue-300/20 bg-blue-400/10 px-3 py-1.5 text-xs font-semibold text-blue-200">{icon}{children}</span>; }
function FlowCard({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <div className="flex gap-4 rounded-2xl border border-white/10 bg-white/[.06] p-5"><span className="grid size-11 shrink-0 place-items-center rounded-xl bg-blue-500/15 text-blue-300">{icon}</span><div><p className="font-semibold">{title}</p><p className="mt-1 text-sm leading-6 text-slate-400">{text}</p></div></div>; }
function StatusCard({ icon, title, status, text }: { icon: React.ReactNode; title: string; status: string; text: string }) { return <div className="rounded-2xl border border-white/10 bg-white/[.06] p-6"><div className="flex items-center justify-between"><span className="grid size-11 place-items-center rounded-xl bg-blue-500/15 text-blue-300">{icon}</span><span className="rounded-full bg-emerald-400/15 px-3 py-1 text-xs font-bold text-emerald-300">{status}</span></div><h3 className="mt-5 text-lg font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-slate-400">{text}</p></div>; }
function PipelineRow({ number, title, text }: { number: string; title: string; text: string }) { return <div className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[.06] p-5"><span className="text-2xl font-bold text-blue-400">{number}</span><div><p className="font-semibold">{title}</p><p className="mt-1 text-sm text-slate-400">{text}</p></div><Check className="ml-auto text-emerald-300" size={20}/></div>; }
function Decision({ title, value, active = false, muted = false }: { title: string; value: string; active?: boolean; muted?: boolean }) { return <div className={`rounded-2xl border p-5 ${active ? "border-blue-400/40 bg-blue-500/15" : "border-white/10 bg-white/[.05]"} ${muted ? "opacity-60" : ""}`}><p className="text-sm text-slate-400">{title}</p><p className="mt-1 font-semibold">{value}</p></div>; }
function Gate({ ok = false, title, text }: { ok?: boolean; title: string; text: string }) { return <div className="flex gap-4 rounded-2xl border border-white/10 bg-white/[.06] p-5"><span className={`grid size-9 shrink-0 place-items-center rounded-full ${ok ? "bg-emerald-400/15 text-emerald-300" : "bg-slate-700 text-slate-400"}`}>{ok ? <Check size={18}/> : <LockKeyhole size={17}/>}</span><div><p className="font-semibold">{title}</p><p className="mt-1 text-sm leading-6 text-slate-400">{text}</p></div></div>; }
function Tag({ children }: { children: React.ReactNode }) { return <span className="rounded-full bg-blue-400/10 px-3 py-1.5 text-xs font-semibold text-blue-200">{children}</span>; }
