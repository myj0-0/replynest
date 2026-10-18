import type { DraftInput, DraftResult } from "./llm-provider.js";
import {receptionReplyPresentationPrompt} from './reception-reply-prompt.js';

const PROMPT_VERSION = "phase4-copilot-v2";

export async function generateWithDeepSeek(
  input: DraftInput,
  config: { apiKey: string; model: string; baseUrl?: string }
): Promise<DraftResult | undefined> {
  const presentation=input.presentation===undefined?undefined:receptionReplyPresentationPrompt(input.presentation);
  const system = [
    "你是企业客服的回复措辞助手，不是规则判断引擎。",
    "Policy Engine 已完成适用性判断；不得更改其资格、金额、时限、动作或审批要求。",
    "正式知识仅可作为事实依据；历史聊天仅可模仿语气，绝不能从中推导、补充或恢复企业规则。",
    "不得编造优惠、退款承诺、订单状态、政策或事实。依据不足时沿用给定的确定性草稿。",
    "只输出一段可供人工确认的中文客服回复，不输出分析过程、引用列表或 Markdown。"
  ].join("\n")+(presentation?.instruction??'');
  const user = JSON.stringify({
    customer_question: input.question,
    allowed_context: input.context,
    policy_engine_results: input.policies,
    formal_knowledge: input.knowledge,
    verified_business_data: input.businessData,
    historical_tone_examples_only: input.history,
    deterministic_fallback_draft: input.deterministicText,
    ...(presentation?{presentation:presentation.data}:{})
  });
  const response = await fetch(`${(config.baseUrl ?? "https://api.deepseek.com").replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      thinking: { type: "disabled" },
      stream: false,
      max_tokens: 500
    }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`DeepSeek request failed with status ${response.status}`);
  const body = await response.json() as { model?: string; choices?: Array<{ message?: { content?: string | null } }> };
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) return undefined;
  return {
    text: text.slice(0, 4000),
    model: body.model || config.model,
    promptVersion: PROMPT_VERSION,
    provider: "deepseek"
  };
}
