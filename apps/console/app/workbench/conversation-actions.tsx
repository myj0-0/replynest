"use client";

import { Check, Loader2, UserCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {workbenchRole} from '../../lib/workbench-labels';

type Status = "open" | "pending" | "resolved" | "snoozed" | "unknown";
type Role = "tenant_admin" | "supervisor" | "agent";
type Assignee = { member_id: string; display_name: string; role: string };

export function ConversationActions({
  conversationId, status, assigneeId, actorId, role, assignees, en
}: {
  conversationId: string; status: Status; assigneeId: string | null; actorId: string; role: Role; assignees: Assignee[]; en: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"claim" | "assign" | "status" | null>(null);
  const [nextStatus, setNextStatus] = useState<"open" | "pending" | "resolved">(
    status === "pending" || status === "resolved" ? status : "open"
  );
  const [error, setError] = useState("");
  const [targetAssigneeId, setTargetAssigneeId] = useState(assigneeId ?? assignees[0]?.member_id ?? "");
  const canClaim = assigneeId === null;
  const canSetStatus = role !== "agent" || assigneeId === actorId;
  const canAssign = role === "tenant_admin" || role === "supervisor";

  async function execute(kind: "claim" | "assign" | "status") {
    setBusy(kind); setError("");
    const body = kind === "claim"
      ? { action: "claim", expected_assignee_id: assigneeId }
      : kind === "assign"
        ? { action: "assign", assignee_id: targetAssigneeId, expected_assignee_id: assigneeId }
        : { action: "set_status", status: nextStatus, expected_status: status };
    try {
      const response = await fetch(`/api/conversations/${conversationId}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body)
      });
      const result = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message || (en ? "The action could not be completed." : "操作未能完成。"));
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : (en ? "The action could not be completed." : "操作未能完成。"));
    } finally { setBusy(null); }
  }

  const [expanded, setExpanded] = useState(false);
  return <div className="border-b border-[var(--border-subtle)] bg-white px-3 py-1 md:py-2">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className="py-1 text-xs text-slate-600 md:hidden">{expanded ? (en ? "Hide conversation actions" : "收起会话操作") : (en ? "Status / Assignment" : "状态 / 转派")} ⌄</button>
    <div className={`${expanded ? "flex" : "hidden md:flex"} flex-wrap items-center gap-2`}>
      {canClaim && <button type="button" disabled={busy !== null} onClick={() => execute("claim")} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-500)] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
        {busy === "claim" ? <Loader2 className="animate-spin" size={14}/> : <UserCheck size={14}/>} {en ? "Claim conversation" : "认领会话"}
      </button>}
      {canSetStatus && <><select aria-label={en ? "Conversation status" : "会话状态"} value={nextStatus} onChange={event => setNextStatus(event.target.value as typeof nextStatus)} disabled={busy !== null} className="rounded-lg border border-[var(--border-subtle)] bg-white px-3 py-2 text-xs">
        <option value="open">{en ? "Open" : "待处理"}</option><option value="pending">{en ? "Pending" : "等待中"}</option><option value="resolved">{en ? "Resolved" : "已解决"}</option>
      </select><button type="button" disabled={busy !== null || nextStatus === status} onClick={() => execute("status")} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs font-semibold disabled:opacity-40">
        {busy === "status" ? <Loader2 className="animate-spin" size={14}/> : <Check size={14}/>} {en ? "Apply status" : "更新状态"}
      </button></>}
      {canAssign && assignees.length > 0 && <><span className="mx-1 hidden h-6 w-px bg-[var(--border-subtle)] sm:block"/><select aria-label={en ? "Assign to" : "转派给"} value={targetAssigneeId} onChange={event => setTargetAssigneeId(event.target.value)} disabled={busy !== null} className="max-w-48 rounded-lg border border-[var(--border-subtle)] bg-white px-3 py-2 text-xs">
        {assignees.map(member => <option key={member.member_id} value={member.member_id}>{member.display_name} · {workbenchRole(member.role,en)}</option>)}
      </select><button type="button" disabled={busy !== null || !targetAssigneeId || targetAssigneeId === assigneeId} onClick={() => execute("assign")} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs font-semibold disabled:opacity-40">
        {busy === "assign" ? <Loader2 className="animate-spin" size={14}/> : <UserCheck size={14}/>} {en ? "Assign" : "转派"}
      </button></>}
      {!canClaim && !canSetStatus && <span className="text-xs text-[var(--ink-500)]">{en ? "Only the assigned agent or a supervisor can change this conversation." : "仅当前负责人或主管可变更此会话。"}</span>}
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
  </div>;
}
