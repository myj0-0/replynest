export type ConfidenceLevel = "high" | "medium" | "low";

export type RecommendationConfidence = {
  score: number;
  percent: number;
  level: ConfidenceLevel;
  evidence_source_count: number;
  auto_reply_candidate: boolean;
  delivery_mode: "human_confirmation";
  reasons: string[];
};

type ConfidenceInput = {
  status: "generated" | "blocked_by_policy_conflict" | "insufficient_evidence";
  policies: Array<{ requires_human_approval?: boolean }>;
  knowledge: Array<{ retrieval?: string; score?: number }>;
  toolResults: Array<{ status: string }>;
  historyCount: number;
};

function rounded(value: number): number {
  return Math.round(Math.max(0, Math.min(0.98, value)) * 100) / 100;
}

export function assessRecommendationConfidence(input: ConfidenceInput): RecommendationConfidence {
  const reasons: string[] = [];
  if (input.status === "blocked_by_policy_conflict") {
    return { score: 0, percent: 0, level: "low", evidence_source_count: 0, auto_reply_candidate: false, delivery_mode: "human_confirmation", reasons: ["企业规则存在冲突，禁止形成可发送建议"] };
  }

  const hasPolicy = input.policies.length > 0;
  const hasKnowledge = input.knowledge.length > 0;
  const succeededTools = input.toolResults.filter(item => item.status === "succeeded").length;
  const failedTools = input.toolResults.filter(item => item.status !== "succeeded").length;
  const sourceCount = Number(hasPolicy) + Number(hasKnowledge) + Number(succeededTools > 0);
  let score = input.status === "insufficient_evidence" ? 0.08 : 0.35;

  if (hasPolicy) { score = Math.max(score, 0.72); reasons.push(`命中 ${input.policies.length} 条当前有效企业规则`); }
  if (hasKnowledge) {
    score = Math.max(score, 0.62);
    score += hasPolicy ? 0.1 : 0;
    reasons.push(`检索到 ${input.knowledge.length} 条正式企业知识`);
    if (input.knowledge.some(item => item.retrieval === "semantic" && Number(item.score ?? 0) >= 0.55)) {
      score += 0.03;
      reasons.push("语义检索相关度达到稳健阈值");
    }
  }
  if (succeededTools) {
    score = Math.max(score, 0.76);
    score += hasPolicy ? 0.1 : 0;
    score += hasKnowledge ? 0.04 : 0;
    reasons.push(`完成 ${succeededTools} 项实时业务数据核验`);
  }
  if (failedTools) {
    score -= 0.22;
    reasons.push(`${failedTools} 项实时业务数据核验失败或未找到`);
  }
  if (input.historyCount) reasons.push("历史会话只作为表达参考，不计入依据置信度");
  if (!sourceCount) reasons.push("未找到可验证的企业规则、正式知识或实时业务数据");
  if (input.policies.some(item => item.requires_human_approval)) reasons.push("适用规则要求人工确认");

  const finalScore = rounded(score);
  const level: ConfidenceLevel = finalScore >= 0.85 ? "high" : finalScore >= 0.6 ? "medium" : "low";
  const autoReplyCandidate = level === "high"
    && hasPolicy
    && sourceCount >= 2
    && failedTools === 0
    && input.policies.every(item => !item.requires_human_approval);
  return {
    score: finalScore,
    percent: Math.round(finalScore * 100),
    level,
    evidence_source_count: sourceCount,
    auto_reply_candidate: autoReplyCandidate,
    delivery_mode: "human_confirmation",
    reasons
  };
}
