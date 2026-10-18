"use client";

import { AlertTriangle, BookOpen, Bot, CheckCircle2, Gauge, History, LoaderCircle, ShieldCheck, Sparkles, X } from "lucide-react";
import { BodyPortal } from "../../components/body-portal";
import { useMemo, useState } from "react";

type Evidence = Record<string, unknown>;
type Recommendation = {
  recommendation_id: string;
  status: string;
  recommendation_text: string | null;
  valid_until: string;
  evidence_panel: { policy?: Evidence[]; knowledge?: Evidence[]; business_data?: Evidence[]; historical_examples?: Evidence[] };
  confidence: { percent: number; level: "high" | "medium" | "low"; reasons: string[]; evidence_source_count: number; delivery_mode: "human_confirmation" };
  conflict_policy_ids?: string[];
};

export function WorkbenchAiAssistant({ conversationId, initialQuestion, en }: { conversationId: string; initialQuestion: string; en: boolean }) {
  const [question, setQuestion] = useState(initialQuestion);
  const [contextOpen, setContextOpen] = useState(!initialQuestion.trim());
  const [orderId, setOrderId] = useState("");
  const [recommendation, setRecommendation] = useState<Recommendation>();
  const [loading, setLoading] = useState(false);
  const [inserting, setInserting] = useState(false);
  const [message, setMessage] = useState("");
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const evidenceCount = useMemo(() => recommendation ? Object.values(recommendation.evidence_panel).reduce((sum, items) => sum + (items?.length ?? 0), 0) : 0, [recommendation]);

  async function generate() {
    if (!question.trim() || loading) return;
    setLoading(true); setMessage(""); setRecommendation(undefined);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/recommendations`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: question.trim(), ...(orderId.trim() ? { order_id: orderId.trim() } : {}) })
      });
      const body = await response.json() as { data?: Recommendation; error?: { message?: string } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? (en ? "Could not generate a suggestion." : "无法生成建议。"));
      setRecommendation(body.data);
    } catch (error) { setMessage(error instanceof Error ? error.message : (en ? "Could not generate a suggestion." : "无法生成建议。")); }
    finally { setLoading(false); }
  }

  async function insert() {
    const text = recommendation?.recommendation_text?.trim();
    if (!recommendation || !text || recommendation.status !== "generated" || inserting) return;
    setInserting(true); setMessage("");
    try {
      const response = await fetch(`/api/copilot/recommendations/${recommendation.recommendation_id}/actions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "inserted", text })
      });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? (en ? "The suggestion is no longer applicable." : "这条建议已不再适用。"));
      window.dispatchEvent(new CustomEvent("replynest:composer:insert", { detail: { conversationId, recommendationId: recommendation.recommendation_id, text } }));
      setMessage(en ? "Inserted into the reply box. Review or edit it, then send manually." : "已填入回复框。请核对或修改后，再由人工发送。");
    } catch (error) { setMessage(error instanceof Error ? error.message : (en ? "Could not insert the suggestion." : "无法填入建议。")); }
    finally { setInserting(false); }
  }

  const blocked = recommendation?.status === "blocked_by_policy_conflict";
  const insufficient = recommendation?.status === "insufficient_evidence";
  return <section aria-label={en ? "AI reply assistant" : "AI 回复助手"} className="overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-white shadow-sm">
    <div className="min-h-16 max-h-[clamp(64px,20dvh,176px)] overflow-y-auto overscroll-contain px-3 py-2">
      {contextOpen ? <div className="space-y-2">
        <label className="block text-xs text-[var(--ink-500)]">{en ? "Customer question" : "客户问题"}
          <textarea aria-label={en ? "Customer question" : "客户问题"} value={question} disabled={loading || inserting} onChange={event => { setQuestion(event.target.value); setRecommendation(undefined); }} maxLength={4000} rows={2} className="mt-1 block w-full resize-none rounded-lg border border-[var(--border-subtle)] bg-slate-50 px-2 py-1 text-sm leading-6 outline-none focus:border-[var(--brand-500)]"/>
        </label>
        <input aria-label={en ? "Order ID (optional)" : "订单号（可选）"} value={orderId} disabled={loading || inserting} onChange={event => { setOrderId(event.target.value); setRecommendation(undefined); }} maxLength={100} placeholder={en ? "Order ID (optional)" : "订单号（可选）"} className="w-full rounded-lg border border-[var(--border-subtle)] px-2 py-1 text-xs"/>
      </div> : <>
        {!recommendation && !loading && <div className="text-sm leading-6">
          <p className="text-[var(--ink-500)]">{en ? "Generate a draft using this message and your business knowledge." : "根据当前客户消息与企业知识，生成可核对的回复草稿。"}</p>
          <p className="mt-1 truncate text-xs text-[var(--ink-500)]" title={question}>{en ? "Regarding: " : "针对："}{question || (en ? "Add a customer question first" : "请先补充客户问题")}</p>
        </div>}
        {loading && <p role="status" className="flex min-h-16 items-center gap-2 text-sm text-[var(--ink-500)]"><LoaderCircle size={16} className="animate-spin"/>{en ? "Checking knowledge and preparing a draft…" : "正在核对知识依据并生成草稿…"}</p>}
        {recommendation?.recommendation_text && <p className="whitespace-pre-wrap break-words text-sm leading-6 text-[var(--ink-900)]">{recommendation.recommendation_text}</p>}
        {(blocked || insufficient) && <p role="status" className="mt-2 flex gap-2 text-xs leading-5 text-amber-800"><AlertTriangle size={15} className="shrink-0"/>{blocked ? (en ? "Policies conflict. Please handle manually." : "企业规则存在冲突，请人工处理。") : (en ? "Insufficient verified evidence. Please handle manually." : "可验证依据不足，请人工处理。")}</p>}
      </>}
      {message && <p role="status" className="mt-2 text-xs leading-5 text-[var(--ink-500)]">{message}</p>}
    </div>
    {<div className="flex h-10 items-center gap-2 overflow-x-auto whitespace-nowrap border-t border-[var(--border-subtle)] px-3 py-1.5">
      {recommendation && <><span title={recommendation.confidence.reasons.join("；")} className={`inline-flex items-center gap-1 text-[11px] ${recommendation.confidence.level === "high" ? "text-emerald-700" : "text-amber-800"}`}><Gauge size={13}/>{en ? "Evidence confidence" : "依据置信度"} {recommendation.confidence.percent}%</span>
      <button type="button" onClick={() => setEvidenceOpen(true)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[var(--brand-700)] hover:bg-blue-50"><BookOpen size={13}/>{en ? `Sources (${evidenceCount})` : `引用依据（${evidenceCount}）`}</button></>}
    </div>}
    <div className="flex min-h-[52px] items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3 py-2">
      <button type="button" disabled={loading || inserting} aria-expanded={contextOpen} onClick={() => setContextOpen(value => !value)} className="rounded-lg px-1 py-2 text-xs text-[var(--ink-500)] hover:bg-slate-50 disabled:opacity-40">{contextOpen ? (en ? "Done" : "完成") : (en ? "Context" : "补充信息")}</button>
      <div className="flex items-center gap-2">
        {recommendation && <button type="button" onClick={() => { setContextOpen(false); void generate(); }} disabled={loading || inserting || !question.trim()} className="rounded-xl border border-[var(--border-subtle)] px-3 py-2 text-xs font-semibold disabled:opacity-40">{en ? "Regenerate" : "重新生成"}</button>}
        <button type="button" onClick={() => { if (recommendation) void insert(); else { setContextOpen(false); void generate(); } }} disabled={loading || inserting || !question.trim() || (!!recommendation && (recommendation.status !== "generated" || !recommendation.recommendation_text))} className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-[var(--brand-500)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-45">
          {loading || inserting ? <LoaderCircle size={16} className="animate-spin"/> : recommendation ? <CheckCircle2 size={16}/> : <Sparkles size={16}/>}
          {loading ? (en ? "Generating…" : "生成中…") : recommendation ? (en ? "Use draft" : "填入回复") : (en ? "Generate draft" : "生成草稿")}
        </button>
      </div>
    </div>
    {evidenceOpen && recommendation && <BodyPortal><EvidenceDialog evidence={recommendation.evidence_panel} en={en} onClose={() => setEvidenceOpen(false)}/></BodyPortal>}
  </section>;
}

function EvidenceDialog({ evidence, en, onClose }: { evidence: Recommendation["evidence_panel"]; en: boolean; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-end bg-slate-950/40 p-2 sm:items-center sm:justify-center" role="dialog" aria-modal="true"><div className="max-h-[88vh] w-full max-w-xl overflow-hidden rounded-2xl bg-slate-50 shadow-2xl"><header className="flex items-start gap-3 border-b bg-white p-4"><BookOpen className="mt-0.5 text-blue-700" size={19}/><div><h3 className="font-semibold">{en ? "Sources for this suggestion" : "本条建议引用依据"}</h3><p className="mt-1 text-xs text-[var(--ink-500)]">{en ? "Verify these sources before sending and report outdated knowledge for revision." : "发送前请核对来源；发现过期内容时，请反馈修订知识库。"}</p></div><button onClick={onClose} className="ml-auto rounded-lg p-1 hover:bg-slate-100" aria-label={en ? "Close" : "关闭"}><X size={17}/></button></header><div className="max-h-[calc(88vh-85px)] space-y-3 overflow-y-auto p-3"><EvidenceGroup title={en ? "Applicable policies" : "适用企业规则"} icon={<ShieldCheck size={15}/>} items={evidence.policy ?? []} en={en}/><EvidenceGroup title={en ? "Business knowledge" : "企业知识库"} icon={<BookOpen size={15}/>} items={evidence.knowledge ?? []} en={en}/><EvidenceGroup title={en ? "Live business data" : "实时业务数据"} icon={<Bot size={15}/>} items={evidence.business_data ?? []} en={en}/><EvidenceGroup title={en ? "Wording examples only" : "仅作措辞参考的历史表达"} icon={<History size={15}/>} items={evidence.historical_examples ?? []} en={en} toneOnly/></div></div></div>;
}

function EvidenceGroup({ title, icon, items, en, toneOnly = false }: { title: string; icon: React.ReactNode; items: Evidence[]; en: boolean; toneOnly?: boolean }) {
  if (!items.length) return null;
  return <section className="rounded-xl border border-[var(--border-subtle)] bg-white p-3"><div className="flex items-center gap-2 text-sm font-semibold">{icon}{title}<span className="ml-auto text-xs text-[var(--ink-500)]">{items.length}</span></div>{toneOnly && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">{en ? "Not a business rule or verified fact." : "不是企业规则或已核验业务事实。"}</p>}<div className="mt-2 space-y-2">{items.map((item, index) => <div key={String(item.source_id ?? index)} className="rounded-lg bg-slate-50 p-2.5 text-xs leading-5"><p className="font-medium">{String(item.label ?? item.title ?? `${en ? "Source" : "依据"} ${index + 1}`)}</p>{item.version != null && <p className="text-[10px] text-[var(--ink-500)]">{en ? "Version" : "版本"} {String(item.version)}</p>}{item.excerpt != null && <p className="mt-1 text-[var(--ink-700)]">{String(item.excerpt)}</p>}{item.warning != null && <p className="mt-1 text-amber-700">{String(item.warning)}</p>}</div>)}</div></section>;
}
