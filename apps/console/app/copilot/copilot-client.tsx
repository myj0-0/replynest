"use client";

import { AlertTriangle, BookOpen, Bot, Check, Clipboard, Gauge, History, RefreshCw, ShieldCheck, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type ChatwootMessage = { id?: number; content?: string; message_type?: number | string; private?: boolean; created_at?: number };
type AppContext = { conversation: { id: number; account_id: number; messages?: ChatwootMessage[] }; currentAgent: { email: string; name?: string } };
type Citation = Record<string, unknown>;
type Recommendation = {
  recommendation_id: string;
  status: string;
  recommendation_text: string | null;
  valid_until: string;
  generation: { provider: string; model: string; fallback_reason: string | null };
  evidence_panel: { policy?: Citation[]; knowledge?: Citation[]; business_data?: Citation[]; historical_examples?: Citation[] };
  conflict_policy_ids?: string[];
  confidence: {
    score: number;
    percent: number;
    level: "high" | "medium" | "low";
    evidence_source_count: number;
    auto_reply_candidate: boolean;
    delivery_mode: "human_confirmation";
    reasons: string[];
  };
};

function parseContext(data: unknown): AppContext | undefined {
  try {
    const value = typeof data === "string" ? JSON.parse(data) : data;
    if (!value || typeof value !== "object" || (value as any).event !== "appContext") return undefined;
    const context = (value as any).data;
    if (!Number.isInteger(context?.conversation?.id) || !Number.isInteger(context?.conversation?.account_id)) return undefined;
    if (typeof context?.currentAgent?.email !== "string") return undefined;
    return context as AppContext;
  } catch {
    return undefined;
  }
}

function latestIncoming(messages: ChatwootMessage[] = []) {
  return [...messages].reverse().find(item => !item.private && (item.message_type === 0 || item.message_type === "incoming") && item.content?.trim())?.content?.trim() ?? "";
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

function EvidenceSection({ title, icon, items, toneOnly = false, en = false }: { title: string; icon: React.ReactNode; items: Citation[]; toneOnly?: boolean; en?: boolean }) {
  if (!items.length) return null;
  return <section className="rounded-xl border border-[var(--border-subtle)] bg-white p-3.5">
    <div className="flex items-center gap-2 text-sm font-semibold">{icon}{title}<span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-[var(--ink-500)]">{items.length}</span></div>
    {toneOnly && <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-xs leading-5 text-amber-900">{en ? "Wording reference only; not a business rule or verified fact." : "仅供措辞参考，不是企业规则或业务事实。"}</p>}
    <div className="mt-2 space-y-2">{items.map((item, index) => {
      const metadata = [
        item.document_version ? `${en ? "Version" : "版本"} ${String(item.document_version)}` : null,
        item.policy_version ? `${en ? "Policy version" : "规则版本"} ${String(item.policy_version)}` : null,
        item.retrieval ? (item.retrieval === "semantic" ? (en ? "Semantic search" : "语义检索") : (en ? "Keyword search" : "关键词检索")) : null,
        typeof item.score === "number" ? `${en ? "Relevance" : "相关度"} ${Math.round(item.score * 100)}%` : null,
      ].filter(Boolean).join(" · ");
      return <div key={String(item.source_id ?? item.document_id ?? item.policy_id ?? index)} className="rounded-lg bg-slate-50 p-2.5 text-xs leading-5"><div className="font-medium">{String(item.label ?? item.title ?? item.name ?? item.tool_name ?? `${en ? "Source" : "依据"} ${index + 1}`)}</div>{metadata && <p className="mt-0.5 text-[11px] text-slate-400">{metadata}</p>}{Boolean(item.excerpt) && <p className="mt-1 text-[var(--ink-500)]">{String(item.excerpt)}</p>}{Boolean(item.warning) && <p className="mt-1 text-amber-700">{String(item.warning)}</p>}</div>;
    })}</div>
  </section>;
}

function EvidenceDialog({ evidence, onClose, en }: { evidence: Recommendation["evidence_panel"]; onClose: () => void; en: boolean }) {
  return <div className="fixed inset-0 z-50 flex items-end bg-slate-950/35 p-2 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label={en ? "Sources for this suggestion" : "本条建议引用依据"}>
    <div className="max-h-[88vh] w-full max-w-xl overflow-hidden rounded-2xl bg-slate-50 shadow-2xl">
      <header className="flex items-start gap-3 border-b border-[var(--border-subtle)] bg-white p-4"><div className="rounded-xl bg-blue-50 p-2 text-blue-700"><BookOpen size={19}/></div><div><h2 className="text-base font-semibold">{en ? "Sources for this suggestion" : "本条建议引用依据"}</h2><p className="mt-1 text-xs leading-5 text-[var(--ink-500)]">{en ? "Use these sources to verify the reply. If the business has changed, ask a knowledge-base manager to update them." : "坐席可据此核对回复；若业务已经变化，请反馈给知识库管理员修订来源。"}</p></div><button onClick={onClose} className="ml-auto rounded-lg p-1.5 text-slate-500 hover:bg-slate-100" aria-label={en ? "Close sources" : "关闭依据窗口"}><X size={18}/></button></header>
      <div className="max-h-[calc(88vh-88px)] space-y-3 overflow-y-auto p-3">
        <EvidenceSection en={en} title={en ? "Applicable policies" : "适用政策"} icon={<ShieldCheck size={16} className="text-violet-600" />} items={evidence.policy ?? []} />
        <EvidenceSection en={en} title={en ? "Business knowledge" : "企业知识"} icon={<BookOpen size={16} className="text-blue-600" />} items={evidence.knowledge ?? []} />
        <EvidenceSection en={en} title={en ? "Live business data" : "实时业务数据"} icon={<Check size={16} className="text-green-600" />} items={evidence.business_data ?? []} />
        <EvidenceSection en={en} title={en ? "Historical wording reference" : "历史表达参考"} icon={<History size={16} className="text-amber-600" />} items={evidence.historical_examples ?? []} toneOnly />
      </div>
    </div>
  </div>;
}

function ConfidencePanel({ confidence, en }: { confidence: Recommendation["confidence"]; en: boolean }) {
  const tone = confidence.level === "high"
    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
    : confidence.level === "medium"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-red-200 bg-red-50 text-red-900";
  const label = confidence.level === "high" ? (en ? "High" : "高") : confidence.level === "medium" ? (en ? "Medium" : "中") : (en ? "Low" : "低");
  return <section className={`rounded-xl border p-3 ${tone}`}>
    <div className="flex items-center gap-2 text-sm font-semibold"><Gauge size={17}/>{en ? "Evidence confidence" : "依据置信度"} {confidence.percent}%<span className="ml-auto rounded-full bg-white/80 px-2 py-0.5 text-xs">{label}</span></div>
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/80"><div className="h-full rounded-full bg-current opacity-70" style={{width:`${confidence.percent}%`}}/></div>
    <p className="mt-2 text-xs leading-5">{confidence.reasons.slice(0,2).join(en ? "; " : "；") || (en ? "No verifiable evidence found" : "未找到可验证依据")}。</p>
    <p className="mt-1 text-[11px] opacity-75">{en ? "A human must always confirm before sending; chat history does not increase confidence." : "当前始终由人工确认后发送；历史聊天不增加置信度。"}</p>
  </section>;
}

export function CopilotClient({ chatwootOrigin, embedded = false, locale = "zh" }: { chatwootOrigin: string; embedded?: boolean; locale?: "zh" | "en" }) {
  const en = locale === "en";
  const [context, setContext] = useState<AppContext>();
  const [question, setQuestion] = useState("");
  const [orderId, setOrderId] = useState("");
  const [recommendation, setRecommendation] = useState<Recommendation>();
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"waiting" | "ready" | "loading" | "inserting" | "error" | "recorded">("waiting");
  const [message, setMessage] = useState(en ? "Reading the Chatwoot conversation context…" : "正在读取 Chatwoot 会话上下文…");
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [embedToken, setEmbedToken] = useState<string>();
  const bridgeRequestRef = useRef<string | null>(null);
  const bridgeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const embedAuthRequestRef = useRef<string | null>(null);
  const embedRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextRef = useRef<AppContext | undefined>(undefined);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.origin !== chatwootOrigin) return;
      const raw = typeof event.data === "string" ? (() => { try { return JSON.parse(event.data); } catch { return undefined; } })() : event.data;
      if (raw && typeof raw === "object" && (raw as any).event === "replynest:embed:session" && (raw as any).request_id === embedAuthRequestRef.current) {
        embedAuthRequestRef.current = null;
        const token = (raw as any).data?.token;
        if ((raw as any).ok && typeof token === "string" && /^[a-f0-9]{64}$/i.test(token)) {
          setEmbedToken(token);
          setStatus("ready");
          setMessage("");
          if (embedRefreshRef.current) clearTimeout(embedRefreshRef.current);
          const refreshAfter = Math.max(60, Math.min(Number((raw as any).data?.expires_in ?? 600) - 90, 510)) * 1000;
          embedRefreshRef.current = setTimeout(() => {
            const current = contextRef.current;
            if (!current) return;
            const requestId = crypto.randomUUID();
            embedAuthRequestRef.current = requestId;
            window.parent.postMessage(JSON.stringify({ event: "replynest:embed:authenticate", request_id: requestId, data: { account_id: current.conversation.account_id, conversation_id: current.conversation.id } }), chatwootOrigin);
          }, refreshAfter);
        } else {
          setStatus("error");
          setMessage(en ? "Could not verify the current Chatwoot session. Reopen the service workspace." : "无法核验当前 Chatwoot 登录身份，请重新进入客服工作台。");
        }
        return;
      }
      if (raw && typeof raw === "object" && (raw as any).event === "replynest:composer:result" && (raw as any).request_id === bridgeRequestRef.current) {
        if (bridgeTimeoutRef.current) clearTimeout(bridgeTimeoutRef.current);
        bridgeRequestRef.current = null;
        if ((raw as any).ok) {
          setStatus("recorded");
          setMessage(en ? "The suggestion is in the reply composer. You can edit it before sending; the final difference is recorded after delivery." : "建议已填入当前会话回复框，可继续编辑并由你点击发送；实际发送后系统会记录最终差异。");
        } else {
          setStatus("error");
          setMessage(en ? "Could not insert it automatically. The suggestion is preserved; refresh the workspace and retry." : "未能自动填入回复框，建议已保留，请刷新工作台后重试。");
        }
        return;
      }
      const next = parseContext(raw);
      if (next) {
        contextRef.current = next;
        setContext(next);
        setQuestion(latestIncoming(next.conversation.messages));
        if (embedded) {
          setEmbedToken(undefined);
          setStatus("waiting");
          setMessage(en ? "Verifying the current Chatwoot session…" : "正在核验当前 Chatwoot 登录身份…");
          const requestId = crypto.randomUUID();
          embedAuthRequestRef.current = requestId;
          window.parent.postMessage(JSON.stringify({ event: "replynest:embed:authenticate", request_id: requestId, data: { account_id: next.conversation.account_id, conversation_id: next.conversation.id } }), chatwootOrigin);
        } else {
          setStatus("ready");
          setMessage("");
        }
      }
    };
    window.addEventListener("message", listener);
    window.parent.postMessage("chatwoot-dashboard-app:fetch-info", chatwootOrigin);
    return () => {
      window.removeEventListener("message", listener);
      if (bridgeTimeoutRef.current) clearTimeout(bridgeTimeoutRef.current);
      if (embedRefreshRef.current) clearTimeout(embedRefreshRef.current);
    };
  }, [chatwootOrigin, embedded, en]);

  const evidence = useMemo(() => recommendation?.evidence_panel ?? {}, [recommendation]);

  const generate = async () => {
    if (!context || !question.trim()) return;
    setStatus("loading"); setMessage(""); setRecommendation(undefined);
    try {
      const response = await fetch("/api/copilot/recommend", { method: "POST", headers: { "content-type": "application/json", ...(embedToken ? { authorization: `Bearer ${embedToken}` } : {}) }, body: JSON.stringify({ conversation_id: context.conversation.id, account_id: context.conversation.account_id, current_agent_email: context.currentAgent.email, question: question.trim(), order_id: orderId.trim() || undefined }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? (en ? "Generation failed" : "生成失败"));
      setRecommendation(body.data); setDraft(body.data.recommendation_text ?? ""); setStatus("ready");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : (en ? "Generation failed" : "生成失败")); }
  };

  const recordAction = async (action: "inserted" | "rejected", text?: string) => {
    if (!recommendation) return;
    const response = await fetch(`/api/copilot/recommendations/${recommendation.recommendation_id}/actions`, { method: "POST", headers: { "content-type": "application/json", ...(embedToken ? { authorization: `Bearer ${embedToken}` } : {}) }, body: JSON.stringify({ action, ...(action === "inserted" ? { text } : {}) }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? (en ? "Could not record this action" : "记录操作失败"));
    return body;
  };

  const insertIntoComposer = async () => {
    if (!recommendation || !context || !draft.trim()) return;
    setStatus("inserting"); setMessage("");
    try {
      await recordAction("inserted", draft.trim());
      const requestId = crypto.randomUUID();
      bridgeRequestRef.current = requestId;
      window.parent.postMessage(JSON.stringify({
        event: "replynest:composer:insert",
        request_id: requestId,
        data: {
          recommendation_id: recommendation.recommendation_id,
          account_id: context.conversation.account_id,
          conversation_id: context.conversation.id,
          text: draft.trim(),
        },
      }), chatwootOrigin);
      bridgeTimeoutRef.current = setTimeout(async () => {
        if (bridgeRequestRef.current !== requestId) return;
        bridgeRequestRef.current = null;
        await copyText(draft.trim());
        setStatus("recorded");
        setMessage(en ? "The workspace did not respond, so the suggestion was copied. Paste it into the composer and send manually." : "工作台尚未响应自动填入，建议已复制；请粘贴到回复框并人工发送。");
      }, 3_000);
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : (en ? "Could not insert into the composer" : "填入回复框失败")); }
  };

  const reject = async () => {
    try {
      await recordAction("rejected");
      setStatus("recorded"); setMessage(en ? "Marked as not used." : "已标记为不采用。");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : (en ? "Could not record this action" : "记录操作失败")); }
  };

  return <main className={embedded ? "min-h-full bg-slate-50 p-3 text-[var(--ink-900)]" : "mx-auto min-h-screen max-w-5xl p-4 text-[var(--ink-900)] md:p-8"}>
    <header className={`border border-[var(--border-subtle)] bg-gradient-to-br from-[var(--brand-50)] via-white to-[var(--ai-soft)] shadow-[var(--shadow-card)] ${embedded ? "rounded-xl p-3" : "rounded-2xl p-5 md:p-6"}`}><div className="flex items-center gap-2 text-sm font-semibold text-[var(--ai)]"><Sparkles size={17} />ReplyNest Copilot</div><h1 className={embedded ? "mt-1 text-lg font-semibold" : "mt-2 text-2xl font-semibold"}>{en ? "AI suggested reply" : "AI 推荐回复"}</h1><p className={`${embedded ? "mt-1 text-xs leading-5" : "mt-2 text-sm leading-6"} text-[var(--ink-500)]`}>{en ? "RAG supplies evidence and the Policy Engine checks applicability. Suggestions are never sent automatically." : "RAG 提供依据，Policy Engine 判断规则；建议不会自动发送。"}</p></header>

    {status === "waiting" && <div className="mt-3 rounded-xl border border-blue-100 bg-white p-4 text-sm text-[var(--ink-500)]">{message}</div>}
    {context && <section className="mt-3 rounded-2xl border border-[var(--border-subtle)] bg-white p-4 shadow-sm"><div className="flex items-center gap-2 text-xs text-[var(--ink-500)]"><Bot size={15} />{en ? "Conversation" : "会话"} #{context.conversation.id} · {context.currentAgent.name ?? context.currentAgent.email}</div><label className="mt-3 block text-xs font-medium">{en ? "Customer question" : "客户问题"}</label><textarea value={question} onChange={event => setQuestion(event.target.value)} rows={4} maxLength={4000} className="mt-1.5 w-full resize-y rounded-xl border border-[var(--border-subtle)] p-3 text-sm outline-none focus:border-[var(--brand-500)]" /><label className="mt-3 block text-xs font-medium">{en ? "Order ID (optional, read-only lookup)" : "订单号（可选，只读查询）"}</label><input value={orderId} onChange={event => setOrderId(event.target.value)} maxLength={100} placeholder={en ? "For example, ORD-1001" : "例如 ORD-1001"} className="mt-1.5 w-full rounded-xl border border-[var(--border-subtle)] px-3 py-2.5 text-sm outline-none focus:border-[var(--brand-500)]" /><button onClick={generate} disabled={status === "loading" || !question.trim() || (embedded && !embedToken)} className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--brand-500)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{status === "loading" ? <RefreshCw size={16} className="animate-spin" /> : <Sparkles size={16} />}{status === "loading" ? (en ? "Retrieving evidence and evaluating policy" : "正在检索依据并判断规则") : (en ? "Generate suggested reply" : "生成推荐回复")}</button></section>}

    {message && status !== "waiting" && <div className={`mt-3 rounded-xl border p-3 text-xs leading-5 ${status === "error" ? "border-red-200 bg-red-50 text-red-800" : "border-green-200 bg-green-50 text-green-800"}`}>{message}</div>}

    {recommendation && <>
      <div className="mt-3"><ConfidencePanel confidence={recommendation.confidence} en={en} /></div>
      {recommendation.status === "blocked_by_policy_conflict" && <div className="mt-3 flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"><AlertTriangle className="shrink-0" size={18} /><div><div className="font-semibold">{en ? "Conflicting policies prevent a sendable suggestion" : "政策存在冲突，禁止生成可发送建议"}</div><p className="mt-1 text-xs">{en ? "Conflicting policies" : "冲突规则"}：{recommendation.conflict_policy_ids?.join(en ? ", " : "、") || (en ? "Ask an administrator to review the policies" : "请管理员检查政策")}</p></div></div>}
      {recommendation.status === "insufficient_evidence" && <div className="mt-3 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><AlertTriangle className="shrink-0" size={18} />{en ? "There is not enough verified business evidence. Review manually before replying." : "没有足够的企业依据，请人工核实后回复。"}</div>}
      {recommendation.recommendation_text && <section className="mt-3 rounded-2xl border border-[var(--border-subtle)] bg-white p-4 shadow-sm"><div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={17} className="text-green-600" />{en ? "Suggested reply" : "建议回复"}<button onClick={() => setEvidenceOpen(true)} className="ml-auto inline-flex items-center gap-1 rounded-lg bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700"><BookOpen size={13}/>{en ? "View sources" : "查看引用来源"}</button></div><textarea value={draft} onChange={event => setDraft(event.target.value)} rows={7} maxLength={4000} className="mt-3 w-full resize-y rounded-xl border border-[var(--border-subtle)] p-3 text-sm leading-6 outline-none focus:border-[var(--brand-500)]" /><p className="mt-2 text-[11px] text-[var(--ink-500)]">{en ? "Valid until" : "有效至"} {new Date(recommendation.valid_until).toLocaleString(en ? "en-US" : "zh-CN")} · {recommendation.generation.provider}/{recommendation.generation.model}</p><div className="mt-3 grid grid-cols-2 gap-2"><button onClick={insertIntoComposer} disabled={status === "inserting"} className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[var(--brand-500)] px-3 py-2.5 text-xs font-semibold text-white disabled:opacity-50"><Clipboard size={15} />{status === "inserting" ? (en ? "Inserting" : "正在填入") : (en ? "Insert into composer" : "填入回复框")}</button><button onClick={reject} className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-[var(--border-subtle)] px-3 py-2.5 text-xs font-semibold"><X size={15} />{en ? "Do not use" : "不采用"}</button></div><p className="mt-2 text-[11px] leading-5 text-amber-700">{en ? "Inserting replaces the current draft. You can still edit it in Chatwoot, and it counts as used only after a human sends it." : "填入时会替换当前回复草稿；你仍可在 Chatwoot 中编辑，只有人工点击发送后才计为采用。"}</p></section>}
      {!embedded && <div className="mt-3 space-y-3"><EvidenceSection en={en} title={en ? "Applicable policies" : "适用政策"} icon={<ShieldCheck size={16} className="text-violet-600" />} items={evidence.policy ?? []} /><EvidenceSection en={en} title={en ? "Business knowledge" : "企业知识"} icon={<BookOpen size={16} className="text-blue-600" />} items={evidence.knowledge ?? []} /><EvidenceSection en={en} title={en ? "Live business data" : "实时业务数据"} icon={<Check size={16} className="text-green-600" />} items={evidence.business_data ?? []} /><EvidenceSection en={en} title={en ? "Historical wording reference" : "历史表达参考"} icon={<History size={16} className="text-amber-600" />} items={evidence.historical_examples ?? []} toneOnly /></div>}
      {evidenceOpen && <EvidenceDialog evidence={evidence} onClose={() => setEvidenceOpen(false)} en={en} />}
    </>}
  </main>;
}
