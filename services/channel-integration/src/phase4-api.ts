import { randomUUID } from "node:crypto";
import {handleKnowledgeDraftApi} from './knowledge-drafts.js';
import {handleKnowledgeDocumentApi} from './knowledge-document-api.js';
import {documentControlsEnabled,documentSettings,documentScopeSql} from './knowledge-document-core.js';
import {lockKnowledgeCapacity} from './knowledge-capacity.js';
import { aiPointsEnabled,AiPointsError } from './ai-points.js';
import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "./database.js";
import { evaluatePolicies, type RecommendationContext } from "./policy-engine.js";
import { retrieveEvidence } from "./rag-service.js";
import {listKnowledgePage,KnowledgeCursorError} from './knowledge-list.js';
import { generateReplyDraft } from "./llm-provider.js";
import { credentialAvailable } from "./credential-resolver.js";
import { getTenantAiSettings, validateTenantAiSettings } from "./tenant-ai-settings.js";
import { chunkText, contentChecksum, validateKnowledgeInput } from "./knowledge-ingestion.js";
import { enqueueKnowledgeJob } from "./knowledge-jobs.js";
import { readKnowledgeMultipart } from "./multipart-upload.js";
import {queueKnowledgeReprocessing,KnowledgeProcessingBusy} from './knowledge-retry.js';
import {readableUploadFilename} from './upload-filename.js';
import { validateUploadedFile } from "./file-security.js";
import { buildStorageKey, readStored, removeStored, storeQuarantined } from "./file-storage.js";
import { invokeGetOrder, type GetOrderResult } from "./order-tool.js";
import { readBody, sendJson } from "./shared.js";
import { assertCapacity, EntitlementLimitError, reserveUsage } from "./subscriptions.js";
import { assessRecommendationConfidence } from "./recommendation-confidence.js";
import { emitNotification } from "./notification-gateway.js";

type AuthContext = {
  key_id: string;
  tenant_id: string;
  role: "tenant_admin" | "supervisor" | "agent";
  auth_kind?: "api_key" | "console_session";
  actor_id?: string;
};

function auditActor(auth: AuthContext) {
  return {
    type: auth.auth_kind === "console_session" ? "platform_user" : "tenant_api_key",
    id: auth.actor_id ?? auth.key_id
  };
}

const contextKeys = new Set([
  "product_batch_id", "sku_id", "channel", "campaign_id", "customer_segment", "region",
  "purchase_time", "registration_time", "request_time", "action_time", "conversation_started_at", "order_id"
]);

function respond(response: ServerResponse, status: number, requestId: string, body: Record<string, unknown>) {
  sendJson(response, status, { request_id: requestId, ...body });
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

async function ensureKnowledgeCapacity(tenantId:string,requestedBytes:number){const current=await pool.query<{bytes:string}>(`SELECT COALESCE(SUM(file_size),0)::bigint AS bytes FROM knowledge_documents WHERE tenant_id=$1 AND status<>'deleted'`,[tenantId]);try{await assertCapacity(tenantId,"knowledge_bytes",Number(current.rows[0].bytes),requestedBytes)}catch(error){if(error instanceof EntitlementLimitError)throw error;throw new Error("knowledge entitlement unavailable")}}

function idempotencyKey(request: IncomingMessage): string | undefined {
  const value = String(request.headers["idempotency-key"] ?? "").trim();
  return value && value.length <= 128 ? value : undefined;
}

async function replay(tenantId: string, key: string, endpoint: string) {
  const result = await pool.query(
    `SELECT endpoint, response_status, response_body FROM idempotency_requests
      WHERE tenant_id=$1 AND idempotency_key=$2`,
    [tenantId, key]
  );
  if (!result.rows[0]) return undefined;
  if (result.rows[0].endpoint !== endpoint) return { conflict: true };
  return { status: result.rows[0].response_status, body: result.rows[0].response_body };
}

function sanitizedContext(input: unknown): RecommendationContext {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const result: RecommendationContext = {};
  for (const [key, value] of Object.entries(input)) {
    if (contextKeys.has(key) && typeof value === "string" && value.length <= 300) {
      (result as Record<string, string>)[key] = value;
    }
  }
  return result;
}

function citationPolicy(policy: any) {
  return {
    policy_id: policy.policy_id,
    name: policy.name,
    policy_type: policy.policy_type,
    version: policy.version,
    priority: policy.priority,
    valid_from: policy.valid_from,
    valid_until: policy.valid_until,
    eligibility_time_basis: policy.eligibility_time_basis,
    matched_conditions: policy.matched_conditions,
    decision: policy.decision,
    requires_human_approval: policy.requires_human_approval
  };
}

function buildEvidencePanel(policy: any[], knowledge: any[], tools: GetOrderResult[], history: any[]) {
  return {
    policy: policy.map(item => ({
      display_type: "policy", label: item.name, source_id: item.policy_id, version: item.version,
      validity: { from: item.valid_from, until: item.valid_until }, decision: item.decision,
      matched_conditions: item.matched_conditions, warning: item.requires_human_approval ? "需要人工确认" : null
    })),
    knowledge: knowledge.map(item => ({
      display_type: "knowledge", label: item.title, source_id: item.document_id,
      version: item.document_version, chunk_id: item.chunk_id, excerpt: item.excerpt,
      retrieval: item.retrieval, score: item.score,
      locator: `knowledge://${item.document_id}/v${item.document_version}${item.chunk_id ? `/${item.chunk_id}` : ""}`
    })),
    business_data: tools.map(item => ({
      display_type: "business_data", label: "订单实时查询", source_id: item.invocation_id,
      tool_name: item.tool_name, tool_version: item.tool_version, status: item.status,
      queried_at: item.queried_at, data: item.data, error: item.error,
      warning: item.status === "succeeded" ? "查询结果仅供本次人工回复参考" : "查询失败，禁止推测订单状态"
    })),
    historical_examples: history.map(item => ({
      display_type: "historical_example", label: item.intent, source_id: item.example_id,
      customer_question: item.customer_question, agent_reply: item.agent_reply,
      usage: "tone_only", warning: "仅供措辞参考，不是企业规则或业务事实"
    }))
  };
}

async function getOrderToolApi(request: IncomingMessage, response: ServerResponse, auth: AuthContext, requestId: string) {
  const key = idempotencyKey(request);
  if (!key) return respond(response, 400, requestId, errorBody("idempotency_key_required", "需要有效的 Idempotency-Key"));
  const input = JSON.parse((await readBody(request)).toString("utf8")) as Record<string, unknown>;
  if (Object.keys(input).some(item => !["customer_id", "order_id"].includes(item))) {
    return respond(response, 400, requestId, errorBody("invalid_tool_input", "getOrder 只接受 customer_id 和 order_id"));
  }
  const result = await invokeGetOrder(
    { tenantId: auth.tenant_id, actorId: auditActor(auth).id, role: auth.role },
    { customerId: String(input.customer_id ?? ""), orderId: String(input.order_id ?? ""), idempotencyKey: key, requestId }
  );
  const status = result.status === "succeeded" ? 200 : result.status === "not_found" ? 404 :
    result.status === "invalid_input" ? 400 : result.status === "forbidden" ? 403 :
    result.status === "rate_limited" ? 429 : result.status === "timeout" ? 504 : 502;
  return respond(response, status, requestId, { data: result });
}

async function createRecommendation(request: IncomingMessage, response: ServerResponse, auth: AuthContext, requestId: string) {
  const key = idempotencyKey(request);
  const endpoint = "POST /api/v1/ai/recommendations";
  if (!key) return respond(response, 400, requestId, errorBody("idempotency_key_required", "需要有效的 Idempotency-Key"));
  const previous = await replay(auth.tenant_id, key, endpoint);
  if (previous?.conflict) return respond(response, 409, requestId, errorBody("idempotency_key_reused", "该 Idempotency-Key 已用于其他接口"));
  if (previous && "status" in previous) return sendJson(response, previous.status, previous.body);

  const input = JSON.parse((await readBody(request)).toString("utf8")) as any;
  if (!/^[0-9a-f-]{36}$/i.test(String(input.customer_id ?? ""))) {
    return respond(response, 400, requestId, errorBody("invalid_customer_id", "customer_id 不合法"));
  }
  if (typeof input.question !== "string" || !input.question.trim() || input.question.length > 4000) {
    return respond(response, 400, requestId, errorBody("invalid_question", "问题不能为空且不能超过 4000 字符"));
  }
  const customer = await pool.query(`SELECT customer_id FROM customers WHERE tenant_id=$1 AND customer_id=$2`, [auth.tenant_id, input.customer_id]);
  if (!customer.rows[0]) return respond(response, 404, requestId, errorBody("customer_not_found", "客户不存在"));

  const now = new Date();
  const context = sanitizedContext(input.context);
  context.request_time ??= now.toISOString();
  const toolResults: GetOrderResult[] = [];
  if (context.order_id) {
    const tool = await invokeGetOrder(
      { tenantId: auth.tenant_id, actorId: auditActor(auth).id, role: auth.role },
      { customerId: input.customer_id, orderId: context.order_id, idempotencyKey: `${key}:getOrder`, requestId }
    );
    toolResults.push(tool);
    if (tool.status === "succeeded" && tool.data) {
      context.product_batch_id = tool.data.product_batch_id ?? undefined;
      context.purchase_time = tool.data.placed_at;
    } else {
      delete context.product_batch_id;
      delete context.purchase_time;
    }
  }
  const policy = await evaluatePolicies(auth.tenant_id, context, now);
  const evidence = await retrieveEvidence(auth.tenant_id, input.question.trim(), policy.matched, now, context);
  let status: "generated" | "blocked_by_policy_conflict" | "insufficient_evidence";
  let recommendationText: string | null = null;
  let deterministicText: string | null = null;
  let generation = {
    model: "deterministic-phase4-sample",
    promptVersion: "phase4-deepseek-v1",
    provider: "deterministic" as "deterministic" | "deepseek" | "qwen",
    fallbackReason: undefined as string | undefined
  };
  if (policy.conflict) {
    status = "blocked_by_policy_conflict";
  } else if (policy.matched.length > 0) {
    status = "generated";
    deterministicText = policy.matched[0].reply_guidance;
    if (toolResults[0]?.status === "succeeded" && toolResults[0].data) {
      deterministicText += ` 已查询订单 ${toolResults[0].data.order_id}，当前状态为 ${toolResults[0].data.status}，查询时间 ${toolResults[0].queried_at}。`;
    } else if (toolResults[0]) {
      deterministicText += " 当前无法确认订单状态，请人工核实后再回复客户。";
    }
  } else if (toolResults[0]?.status === "succeeded" && toolResults[0].data) {
    status = "generated";
    deterministicText = `已查询订单 ${toolResults[0].data.order_id}，当前状态为 ${toolResults[0].data.status}，商品为 ${toolResults[0].data.product_summary}，查询时间 ${toolResults[0].queried_at}。请人工确认后回复客户。`;
  } else if (evidence.knowledge.length > 0) {
    status = "generated";
    deterministicText = `根据企业正式知识：${evidence.knowledge[0].content}`;
  } else {
    status = "insufficient_evidence";
    if (toolResults[0]) recommendationText = "订单查询未成功，暂时无法确认订单状态，请人工核实或稍后重试。";
  }
  const policyCitations = policy.matched.map(citationPolicy);
  const knowledgeCitations = evidence.knowledge.map(item => ({
    document_id: item.document_id, title: item.title, source_type: item.source_type,
    document_version: item.version, chunk_id: item.chunk_id ?? null,
    retrieval: item.retrieval ?? "keyword", excerpt: item.content.slice(0, 500), score: item.score
  }));
  const historicalExamples = evidence.history.map(item => ({
    example_id: item.example_id, intent: item.intent, customer_question: item.customer_question,
    agent_reply: item.agent_reply, usage: "tone_only", policy_independent: item.policy_independent, score: item.score
  }));
  const evidencePanel = buildEvidencePanel(policyCitations, knowledgeCitations, toolResults, historicalExamples);
  if (status === "generated" && deterministicText) {
    try { if (!aiPointsEnabled()) await reserveUsage(auth.tenant_id,"ai_actions",1,key,"ai_recommendation_request",key); }
    catch(error){if(error instanceof EntitlementLimitError)return respond(response,429,requestId,{error:{code:"entitlement_limit_reached",message:"本月 AI 建议额度已用完",metric:error.metric,limit:error.limit,used:error.used}});throw error}
    const aiSettings = await getTenantAiSettings(auth.tenant_id);
    const draft = await generateReplyDraft(aiSettings, {
      question: input.question.trim(),
      context,
      policies: policy.matched.map(item => ({
        name: item.name,
        decision: item.decision,
        reply_guidance: item.reply_guidance,
        requires_human_approval: item.requires_human_approval
      })),
      knowledge: evidence.knowledge.map(item => ({ title: item.title, content: item.content })),
      history: evidence.history.map(item => ({
        customer_question: item.customer_question,
        agent_reply: item.agent_reply
      })),
      businessData: toolResults.map(item => ({
        tool_name: item.tool_name, queried_at: item.queried_at, status: item.status,
        data: item.data as unknown as Record<string, unknown> | null,
        error: item.error as unknown as Record<string, unknown> | null
      })),
      deterministicText
    });
    recommendationText = draft.text;
    generation = {
      model: draft.model,
      promptVersion: draft.promptVersion,
      provider: draft.provider,
      fallbackReason: draft.fallbackReason
    };
  }
  const policyExpiry = policy.matched.map(item => new Date(item.valid_until).getTime());
  const validUntil = new Date(Math.min(now.getTime() + 15 * 60_000, ...(policyExpiry.length ? policyExpiry : [Infinity])));
  const confidence = assessRecommendationConfidence({
    status,
    policies: policy.matched,
    knowledge: evidence.knowledge,
    toolResults,
    historyCount: evidence.history.length
  });
  const inserted = await pool.query(
    `INSERT INTO ai_recommendations
      (tenant_id, idempotency_key, customer_id, conversation_id, question, context_snapshot, policy_decisions,
       policy_citations, knowledge_citations, historical_examples, tool_results, evidence_panel, confidence, recommendation_text, status,
       model, prompt_version, generated_at, valid_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),$18)
     RETURNING recommendation_id, generated_at`,
    [auth.tenant_id, key, input.customer_id, input.conversation_id ? String(input.conversation_id) : null,
     input.question.trim(), context, { decision_time: policy.decision_time, conflict: policy.conflict, conflict_policy_ids: policy.conflict_policy_ids },
     JSON.stringify(policyCitations), JSON.stringify(knowledgeCitations), JSON.stringify(historicalExamples), JSON.stringify(toolResults),
     JSON.stringify(evidencePanel), JSON.stringify(confidence), recommendationText, status, generation.model, generation.promptVersion, validUntil]
  );
  const responseBody = {
    request_id: requestId,
    data: {
      recommendation_id: inserted.rows[0].recommendation_id,
      status,
      recommendation_text: recommendationText,
      generated_at: inserted.rows[0].generated_at,
      valid_until: validUntil.toISOString(),
      requires_human_confirmation: true,
      generation: {
        provider: generation.provider,
        model: generation.model,
        prompt_version: generation.promptVersion,
        fallback_reason: generation.fallbackReason ?? null
      },
      policy_citations: policyCitations,
      knowledge_citations: knowledgeCitations,
      historical_examples: historicalExamples,
      tool_results: toolResults,
      evidence_panel: evidencePanel,
      confidence,
      conflict_policy_ids: policy.conflict_policy_ids
    }
  };
  await pool.query(
    `INSERT INTO idempotency_requests (tenant_id,idempotency_key,endpoint,response_status,response_body)
     VALUES ($1,$2,$3,201,$4)`, [auth.tenant_id, key, endpoint, responseBody]
  );
  await pool.query(
    `INSERT INTO audit_logs
      (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
     VALUES ($1,$2,$3,'ai.recommendation.generated','ai_recommendation',$4,
              jsonb_build_object('status',$5::text,'policy_count',$6::int,'knowledge_count',$7::int,'history_count',$8::int,
                                 'generation_provider',$9::text,'generation_model',$10::text,'fallback_reason',$11::text),$12::uuid)`,
    [auth.tenant_id, auditActor(auth).type, auditActor(auth).id, inserted.rows[0].recommendation_id, status,
      policyCitations.length, knowledgeCitations.length, historicalExamples.length,
      generation.provider, generation.model, generation.fallbackReason ?? null, requestId]
  );
  if (confidence.level === "low" && input.conversation_id) {
    try {
      const conversationReference = String(input.conversation_id);
      const stableConversation = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationReference);
      await emitNotification({
        tenant_id: auth.tenant_id,
        event_type: "copilot.human_attention_required",
        severity: "warning",
        title: "AI 建议依据不足，需要人工处理",
        summary: "当前会话未达到可放心采用的依据阈值，请进入客服工作台核实后回复。",
        dedupe_key: `copilot-low-confidence:${String(input.conversation_id).replace(/[^A-Za-z0-9_.-]/g,"-")}`,
        resource_type: stableConversation ? "conversation" : "chatwoot_conversation",
        resource_id: conversationReference,
        metadata: stableConversation ? { conversation_id: conversationReference, source: "copilot" } : { chatwoot_conversation_id: Number(conversationReference), source: "copilot" },
        actor_type: auditActor(auth).type,
        actor_id: auditActor(auth).id,
        request_id: requestId,
        requires_action: true,
        webhook_scope: "message",
        delivery_mode: process.env.COPILOT_LOW_CONFIDENCE_EXTERNAL_NOTIFICATIONS === "true" ? "configured" : "in_app_only"
      });
    } catch (notificationError) {
      console.error("Copilot escalation notification failed", notificationError instanceof Error ? notificationError.message : "unknown");
    }
  }
  return sendJson(response, 201, responseBody);
}

async function getRecommendation(response: ServerResponse, auth: AuthContext, requestId: string, recommendationId: string) {
  const result = await pool.query(
    `SELECT recommendation_id, customer_id, conversation_id, question, context_snapshot, policy_decisions,
            policy_citations, knowledge_citations, historical_examples, tool_results, evidence_panel, confidence, recommendation_text, status,
            model, prompt_version, generated_at, valid_until, human_agent_action, human_agent_text, action_at
       FROM ai_recommendations WHERE tenant_id=$1 AND recommendation_id=$2`,
    [auth.tenant_id, recommendationId]
  );
  return respond(response, result.rows[0] ? 200 : 404, requestId,
    result.rows[0] ? { data: result.rows[0] } : errorBody("recommendation_not_found", "推荐不存在"));
}

async function recordAction(request: IncomingMessage, response: ServerResponse, auth: AuthContext, requestId: string, recommendationId: string) {
  const key = idempotencyKey(request);
  const endpoint = `POST /api/v1/ai/recommendations/${recommendationId}/actions`;
  if (!key) return respond(response, 400, requestId, errorBody("idempotency_key_required", "需要有效的 Idempotency-Key"));
  const previous = await replay(auth.tenant_id, key, endpoint);
  if (previous?.conflict) return respond(response, 409, requestId, errorBody("idempotency_key_reused", "该 Idempotency-Key 已用于其他接口"));
  if (previous && "status" in previous) return sendJson(response, previous.status, previous.body);
  const input = JSON.parse((await readBody(request)).toString("utf8")) as any;
  if (!['inserted', 'accepted', 'edited', 'rejected'].includes(input.action)) {
    return respond(response, 400, requestId, errorBody("invalid_action", "action 必须是 inserted、accepted、edited 或 rejected"));
  }
  if (['inserted', 'edited'].includes(input.action) && (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000)) {
    return respond(response, 400, requestId, errorBody("edited_text_required", "填入或编辑后的文本不能为空"));
  }
  const current = await pool.query<any>(
    `SELECT recommendation_id, status, conversation_id, context_snapshot, policy_citations, knowledge_citations, valid_until
       FROM ai_recommendations WHERE tenant_id=$1 AND recommendation_id=$2`,
    [auth.tenant_id, recommendationId]
  );
  if (!current.rows[0]) return respond(response, 404, requestId, errorBody("recommendation_not_found", "推荐不存在"));
  let nextStatus = input.action as string;
  if (input.action !== 'rejected') {
    const now = new Date();
    const context = { ...(current.rows[0].context_snapshot as RecommendationContext), action_time: now.toISOString() };
    const reevaluated = await evaluatePolicies(auth.tenant_id, context, now);
    const originalPolicyIds = new Set((current.rows[0].policy_citations as any[]).map(item => item.policy_id));
    const currentIds = new Set(reevaluated.matched.map(item => item.policy_id));
    const citations=current.rows[0].knowledge_citations as Array<{document_id:string;document_version:number}>;
    const sources=await pool.query(`SELECT d.document_id,d.version FROM knowledge_documents d WHERE d.tenant_id=$1 AND d.document_id=ANY($2::uuid[])
      AND d.status='active' AND (d.valid_from IS NULL OR d.valid_from<=$3) AND (d.valid_until IS NULL OR d.valid_until>$3)
      ${documentScopeSql('d','$4::jsonb')}`,[auth.tenant_id,citations.map(x=>x.document_id),now,...(documentControlsEnabled()?[JSON.stringify(context)]:[])]);
    const knowledgeChanged=citations.some(x=>!sources.rows.some(d=>d.document_id===x.document_id&&d.version===x.document_version));
    if (knowledgeChanged || now >= new Date(current.rows[0].valid_until) || [...originalPolicyIds].some(id => !currentIds.has(id as string))) {
      nextStatus = 'expired_before_send';
    } else if (reevaluated.conflict) {
      nextStatus = 'blocked_by_policy_conflict';
    }
  }
  const httpStatus = nextStatus === 'expired_before_send' || nextStatus === 'blocked_by_policy_conflict' ? 409 : 200;
  if (nextStatus === 'inserted' && current.rows[0].status !== 'inserted') {
    const conversationId = String(current.rows[0].conversation_id ?? '');
    if (conversationId) {
      await pool.query(
        `UPDATE ai_recommendations SET status='rejected',human_agent_action='superseded',action_at=NOW()
          WHERE tenant_id=$1 AND conversation_id=$2 AND recommendation_id<>$3 AND status='inserted'`,
        [auth.tenant_id, conversationId, recommendationId]
      );
    }
  }
  const updated = await pool.query(
    `UPDATE ai_recommendations SET status=$1, human_agent_action=$2, human_agent_text=$3, action_at=NOW()
      WHERE tenant_id=$4 AND recommendation_id=$5
      RETURNING recommendation_id,status,human_agent_action,human_agent_text,action_at`,
    [nextStatus, input.action, ['inserted', 'edited'].includes(input.action) ? input.text.trim() : null, auth.tenant_id, recommendationId]
  );
  const responseBody = { request_id: requestId, data: updated.rows[0] };
  await pool.query(
    `INSERT INTO idempotency_requests (tenant_id,idempotency_key,endpoint,response_status,response_body)
     VALUES ($1,$2,$3,$4,$5)`, [auth.tenant_id, key, endpoint, httpStatus, responseBody]
  );
  await pool.query(
    `INSERT INTO audit_logs
      (tenant_id,actor_type,actor_id,action,resource_type,resource_id,before_data,after_data,request_id)
     VALUES ($1,$2,$3,'ai.recommendation.action','ai_recommendation',$4,
              jsonb_build_object('status',$5::text),jsonb_build_object('status',$6::text,'action',$7::text),$8::uuid)`,
    [auth.tenant_id, auditActor(auth).type, auditActor(auth).id, recommendationId, current.rows[0].status, nextStatus, input.action, requestId]
  );
  return sendJson(response, httpStatus, responseBody);
}

async function getProviderSettings(response: ServerResponse, auth: AuthContext, requestId: string) {
  const settings = await getTenantAiSettings(auth.tenant_id);
  return respond(response, 200, requestId, {
    data: {
      ...settings,
      llm_credential_available: credentialAvailable(settings.llm_credential_ref),
      embedding_credential_available: credentialAvailable(settings.embedding_credential_ref)
    }
  });
}

async function patchProviderSettings(request: IncomingMessage, response: ServerResponse, auth: AuthContext, requestId: string) {
  if (auth.role !== "tenant_admin") {
    return respond(response, 403, requestId, errorBody("forbidden", "仅企业管理员可修改 AI Provider 配置"));
  }
  const input = JSON.parse((await readBody(request)).toString("utf8")) as Record<string, unknown>;
  const validationError = validateTenantAiSettings(input);
  if (validationError) return respond(response, 400, requestId, errorBody("invalid_provider_settings", validationError));
  const before = await getTenantAiSettings(auth.tenant_id);
  const next = { ...before, ...input } as any;
  if (next.llm_provider === "deterministic") {
    next.llm_model = "deterministic-phase4-sample";
    next.llm_credential_ref = null;
  }
  if (next.llm_provider === "deepseek") {
    next.llm_model ||= "deepseek-v4-flash";
    next.llm_credential_ref = "platform/deepseek";
  }
  if (next.embedding_provider === "none") {
    next.embedding_model = null;
    next.embedding_dimensions = null;
    next.embedding_credential_ref = null;
  }
  if (next.embedding_provider === "gemini") {
    next.embedding_model ||= "gemini-embedding-001";
    next.embedding_dimensions ||= 768;
    next.embedding_credential_ref = "platform/gemini";
  }
  const updated = await pool.query(
    `UPDATE tenant_ai_settings SET
       llm_provider=$2,llm_model=$3,llm_credential_ref=$4,
       embedding_provider=$5,embedding_model=$6,embedding_dimensions=$7,embedding_credential_ref=$8,
       updated_by=$9,updated_at=NOW()
     WHERE tenant_id=$1
     RETURNING tenant_id,llm_provider,llm_model,llm_credential_ref,
               embedding_provider,embedding_model,embedding_dimensions,embedding_credential_ref,updated_at`,
    [auth.tenant_id, next.llm_provider, next.llm_model, next.llm_credential_ref,
     next.embedding_provider, next.embedding_model, next.embedding_dimensions, next.embedding_credential_ref, auth.key_id]
  );
  if (before.embedding_provider !== updated.rows[0].embedding_provider ||
      before.embedding_model !== updated.rows[0].embedding_model ||
      before.embedding_dimensions !== updated.rows[0].embedding_dimensions) {
    await pool.query(
      `UPDATE knowledge_chunks SET embedding=NULL,embedding_status='stale',updated_at=NOW()
        WHERE tenant_id=$1 AND embedding_status='ready'`,
      [auth.tenant_id]
    );
  }
  await pool.query(
    `INSERT INTO audit_logs
      (tenant_id,actor_type,actor_id,action,resource_type,resource_id,before_data,after_data,request_id)
     VALUES ($1,'tenant_api_key',$2,'ai.provider_settings.updated','tenant_ai_settings',$1,$3,$4,$5)`,
    [auth.tenant_id, auth.key_id, before, updated.rows[0], requestId]
  );
  return respond(response, 200, requestId, {
    data: {
      ...updated.rows[0],
      llm_credential_available: credentialAvailable(updated.rows[0].llm_credential_ref),
      embedding_credential_available: credentialAvailable(updated.rows[0].embedding_credential_ref)
    }
  });
}

async function createKnowledgeDocument(request: IncomingMessage, response: ServerResponse, auth: AuthContext, requestId: string) {
  if (auth.role !== "tenant_admin") return respond(response, 403, requestId, errorBody("forbidden", "仅企业管理员可上传知识文档"));
  const key = idempotencyKey(request);
  const endpoint = "POST /api/v1/ai/knowledge/documents";
  if (!key) return respond(response, 400, requestId, errorBody("idempotency_key_required", "需要有效的 Idempotency-Key"));
  const previous = await replay(auth.tenant_id, key, endpoint);
  if (previous?.conflict) return respond(response, 409, requestId, errorBody("idempotency_key_reused", "该 Idempotency-Key 已用于其他接口"));
  if (previous && "status" in previous) return sendJson(response, previous.status, previous.body);
  const input = JSON.parse((await readBody(request)).toString("utf8")) as Record<string, unknown>;
  const validationError = validateKnowledgeInput(input);
  if (validationError) return respond(response, 400, requestId, errorBody("invalid_knowledge_document", validationError));
  const title = String(input.title).trim();
  const content = String(input.content).trim();
  const contentBytes=Buffer.byteLength(content,"utf8");
  try{await ensureKnowledgeCapacity(auth.tenant_id,contentBytes)}catch(error){if(error instanceof EntitlementLimitError)return respond(response,409,requestId,{error:{code:"entitlement_limit_reached",message:"知识库容量已达到套餐上限",metric:error.metric,limit:error.limit,used:error.used}});throw error}
  const chunks = chunkText(content);
  if (!chunks.length) return respond(response, 400, requestId, errorBody("empty_chunks", "文档没有可索引内容"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2,0))`, [auth.tenant_id, title]);
    await lockKnowledgeCapacity(client,auth.tenant_id,contentBytes);
    const versionResult = await client.query<{ version: number }>(
      `SELECT COALESCE(MAX(version),0)+1 AS version FROM knowledge_documents WHERE tenant_id=$1 AND title=$2`,
      [auth.tenant_id, title]
    );
    const version = Number(versionResult.rows[0].version);
    await client.query(
      `UPDATE knowledge_documents SET status='inactive',updated_at=NOW()
        WHERE tenant_id=$1 AND title=$2 AND status='active'`,
      [auth.tenant_id, title]
    );
    const inserted = await client.query<{ document_id: string; created_at: string }>(
      `INSERT INTO knowledge_documents
        (tenant_id,title,source_type,version,status,content,content_format,original_filename,content_checksum,ingestion_status,file_size)
       VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,'chunked',$9) RETURNING document_id,created_at`,
      [auth.tenant_id, title, input.source_type, version, content, input.format, input.filename ?? null, contentChecksum(content),contentBytes]
    );
    for (let index = 0; index < chunks.length; index += 1) {
      await client.query(
        `INSERT INTO knowledge_chunks
          (tenant_id,document_id,document_version,chunk_index,content,embedding_status)
         VALUES ($1,$2,$3,$4,$5,'pending')`,
        [auth.tenant_id, inserted.rows[0].document_id, version, index, chunks[index]]
      );
    }
    if(documentControlsEnabled())await client.query(`UPDATE knowledge_documents SET document_group_id=COALESCE((SELECT d.document_group_id FROM knowledge_documents d WHERE d.tenant_id=$1 AND d.title=$2 AND d.document_id<>$3 ORDER BY version DESC LIMIT 1),$3::uuid) WHERE tenant_id=$1 AND document_id=$3`,[auth.tenant_id,title,inserted.rows[0].document_id]);
    const responseBody = { request_id: requestId, data: {
      document_id: inserted.rows[0].document_id, title, version, format: input.format,
      chunk_count: chunks.length, embedding_status: "pending", created_at: inserted.rows[0].created_at
    } };
    await client.query(
      `INSERT INTO idempotency_requests (tenant_id,idempotency_key,endpoint,response_status,response_body)
       VALUES ($1,$2,$3,201,$4)`, [auth.tenant_id, key, endpoint, responseBody]
    );
    await client.query(
      `INSERT INTO audit_logs
        (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
       VALUES ($1,'tenant_api_key',$2,'knowledge.document.created','knowledge_document',$3,
               jsonb_build_object('title',$4::text,'version',$5::int,'chunk_count',$6::int),$7)`,
      [auth.tenant_id, auth.key_id, inserted.rows[0].document_id, title, version, chunks.length, requestId]
    );
    await client.query("COMMIT");
    return sendJson(response, 201, responseBody);
  } catch (error) {
    await client.query("ROLLBACK");
    if(error instanceof EntitlementLimitError)return respond(response,409,requestId,{error:{code:'entitlement_limit_reached',message:'知识库容量已达到套餐上限',metric:error.metric,limit:error.limit,used:error.used}});
    throw error;
  } finally {
    client.release();
  }
}

async function indexKnowledge(request: IncomingMessage, response: ServerResponse, auth: AuthContext, requestId: string, documentId: string) {
  if (auth.role !== "tenant_admin") return respond(response, 403, requestId, errorBody("forbidden", "仅企业管理员可重建知识索引"));
  const key = idempotencyKey(request);
  const endpoint = `POST /api/v1/ai/knowledge/documents/${documentId}/index`;
  if (!key) return respond(response, 400, requestId, errorBody("idempotency_key_required", "需要有效的 Idempotency-Key"));
  const previous = await replay(auth.tenant_id, key, endpoint);
  if (previous?.conflict) return respond(response, 409, requestId, errorBody("idempotency_key_reused", "该 Idempotency-Key 已用于其他接口"));
  if (previous && "status" in previous) return sendJson(response, previous.status, previous.body);
  const client=await pool.connect();
  try{
  await client.query('BEGIN');
  // Serialize matching idempotency keys even when they target different documents.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2,0))",[auth.tenant_id,key]);
  const repeated=(await client.query('SELECT endpoint,response_status,response_body FROM idempotency_requests WHERE tenant_id=$1 AND idempotency_key=$2',[auth.tenant_id,key])).rows[0];
  if(repeated){await client.query('COMMIT');return repeated.endpoint===endpoint?sendJson(response,repeated.response_status,repeated.response_body):respond(response,409,requestId,errorBody('idempotency_key_reused','该 Idempotency-Key 已用于其他接口'));}
  const job = await queueKnowledgeReprocessing(client,auth.tenant_id,documentId);
  if(!job){await client.query('ROLLBACK');return respond(response,404,requestId,errorBody('knowledge_document_not_found','知识文档不存在或尚未满足重试条件'));}
  const httpStatus = 202;
  const responseBody = { request_id: requestId, data: { ...job, document_id: documentId } };
  await client.query(
    `INSERT INTO idempotency_requests (tenant_id,idempotency_key,endpoint,response_status,response_body)
     VALUES ($1,$2,$3,$4,$5)`, [auth.tenant_id, key, endpoint, httpStatus, responseBody]
  );
  await client.query(
    `INSERT INTO audit_logs
      (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
     VALUES ($1,'tenant_api_key',$2,'knowledge.document.index.queued','knowledge_document',$3,$4,$5)`,
    [auth.tenant_id, auth.key_id, documentId, job, requestId]
  );
  await client.query('COMMIT');
  return sendJson(response, httpStatus, responseBody);
  }catch(error){await client.query('ROLLBACK');if(error instanceof KnowledgeProcessingBusy)return respond(response,409,requestId,errorBody('knowledge_processing_busy','文档仍在处理中，请稍后刷新'));throw error;}finally{client.release();}
}

async function createKnowledgeFile(request: IncomingMessage, response: ServerResponse, auth: AuthContext, requestId: string) {
  if (auth.role !== "tenant_admin") return respond(response, 403, requestId, errorBody("forbidden", "仅企业管理员可上传知识文件"));
  const key = idempotencyKey(request);
  const endpoint = "POST /api/v1/ai/knowledge/files";
  if (!key) return respond(response, 400, requestId, errorBody("idempotency_key_required", "需要有效的 Idempotency-Key"));
  const previous = await replay(auth.tenant_id, key, endpoint);
  if (previous?.conflict) return respond(response, 409, requestId, errorBody("idempotency_key_reused", "该 Idempotency-Key 已用于其他接口"));
  if (previous && "status" in previous) return sendJson(response, previous.status, previous.body);
  let upload;
  try { upload = await readKnowledgeMultipart(request); }
  catch { return respond(response, 400, requestId, errorBody("invalid_multipart", "Multipart 文件、字段或大小不合法")); }
  if (!upload.title || upload.title.length > 200) return respond(response, 400, requestId, errorBody("invalid_title", "title 不能为空且不能超过 200 字符"));
  if (!["knowledge", "faq", "script", "temporary_policy_text"].includes(upload.sourceType)) return respond(response, 400, requestId, errorBody("invalid_source_type", "source_type 不合法"));
  let controls:ReturnType<typeof documentSettings>|undefined;
  if(documentControlsEnabled()){
   try{controls=documentSettings(upload.settings??{});}catch{return respond(response,400,requestId,errorBody('invalid_document_settings','请选择文档类别，并填写有效期与适用范围'));}
  }
  let detected;
  try { detected = validateUploadedFile(upload.filename, upload.mimeType, upload.data); }
  catch (error) { return respond(response, 400, requestId, errorBody("unsafe_or_unsupported_file", error instanceof Error ? error.message : "文件不合法")); }
  try{await ensureKnowledgeCapacity(auth.tenant_id,upload.data.length)}catch(error){if(error instanceof EntitlementLimitError)return respond(response,409,requestId,{error:{code:"entitlement_limit_reached",message:"知识库容量已达到套餐上限",metric:error.metric,limit:error.limit,used:error.used}});throw error}
  const documentId = randomUUID();
  const storageKey = buildStorageKey(auth.tenant_id, documentId, detected.extension);
  await storeQuarantined(storageKey, upload.data);
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2,0))`, [auth.tenant_id, upload.title]);
    await lockKnowledgeCapacity(client,auth.tenant_id,upload.data.length);
    const versionResult = await client.query<{ version: number }>(
      `SELECT COALESCE(MAX(version),0)+1 AS version FROM knowledge_documents WHERE tenant_id=$1 AND title=$2`, [auth.tenant_id, upload.title]
    );
    const version = Number(versionResult.rows[0].version);
    await client.query(
      `INSERT INTO knowledge_documents
        (document_id,tenant_id,title,source_type,version,status,content,content_format,original_filename,
         content_checksum,ingestion_status,storage_key,mime_type,file_size,scan_status,parse_status)
       VALUES ($1,$2,$3,$4,$5,'draft','',$6,$7,$8,'queued',$9,$10,$11,'pending','pending')`,
      [documentId, auth.tenant_id, upload.title, upload.sourceType, version, detected.format, upload.filename,
       contentChecksum(upload.data), storageKey, upload.mimeType, upload.data.length]
    );
    if(controls){
     const root=(await client.query('SELECT document_group_id FROM knowledge_documents WHERE tenant_id=$1 AND title=$2 AND document_id<>$3 ORDER BY version DESC LIMIT 1',[auth.tenant_id,upload.title,documentId])).rows[0]?.document_group_id??documentId;
     await client.query(`UPDATE knowledge_documents SET document_kind=$3,valid_from=$4,valid_until=$5,scope=$6,requires_human_approval=$7,document_group_id=$8
       WHERE tenant_id=$1 AND document_id=$2`,[auth.tenant_id,documentId,controls.document_kind,controls.valid_from,controls.valid_until,controls.scope,controls.requires_human_approval,root]);
    }
    const job = await enqueueKnowledgeJob(auth.tenant_id, documentId, "parse_and_index", client);
    const responseBody = { request_id: requestId, data: {
      document_id: documentId, title: upload.title, version, filename: upload.filename,
      format: detected.format, file_size: upload.data.length, ingestion_status: "queued", job
    } };
    await client.query(`INSERT INTO idempotency_requests (tenant_id,idempotency_key,endpoint,response_status,response_body) VALUES ($1,$2,$3,202,$4)`, [auth.tenant_id, key, endpoint, responseBody]);
    await client.query(
      `INSERT INTO audit_logs
        (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
       VALUES ($1,'tenant_api_key',$2,'knowledge.file.queued','knowledge_document',$3,
               jsonb_build_object('title',$4::text,'version',$5::int,'format',$6::text,'file_size',$7::int,'job_id',$8::text),$9)`,
      [auth.tenant_id, auth.key_id, documentId, upload.title, version, detected.format, upload.data.length, job.job_id, requestId]
    );
    await client.query("COMMIT");
    return sendJson(response, 202, responseBody);
  } catch (error) {
    if (client) await client.query("ROLLBACK");
    await removeStored(storageKey);
    if(error instanceof EntitlementLimitError)return respond(response,409,requestId,{error:{code:'entitlement_limit_reached',message:'知识库容量已达到套餐上限',metric:error.metric,limit:error.limit,used:error.used}});
    throw error;
  } finally { client?.release(); }
}

async function getKnowledgeJob(response: ServerResponse, auth: AuthContext, requestId: string, jobId: string) {
  const result = await pool.query(
    `SELECT job_id,document_id,job_type,status,progress,attempts,max_attempts,scheduled_at,last_error,result,created_at,updated_at
       FROM knowledge_jobs WHERE tenant_id=$1 AND job_id=$2`, [auth.tenant_id, jobId]
  );
  return respond(response, result.rows[0] ? 200 : 404, requestId,
    result.rows[0] ? { data: result.rows[0] } : errorBody("knowledge_job_not_found", "知识处理任务不存在"));
}

type ReadableKnowledgeDocument = {
  document_id: string;
  title: string;
  source_type: string;
  version: number;
  status: "active" | "inactive";
  content: string;
  content_format: string;
  original_filename: string | null;
  storage_key: string | null;
  mime_type: string | null;
  file_size: string | number | null;
  ingestion_status: string;
  scan_status: string;
  parse_status: string;
  updated_at: string;
};

async function readableKnowledgeDocument(tenantId: string, documentId: string): Promise<ReadableKnowledgeDocument | undefined> {
  const result = await pool.query<ReadableKnowledgeDocument>(
    `SELECT document_id,title,source_type,version,status,content,content_format,original_filename,
            storage_key,mime_type,file_size,ingestion_status,scan_status,parse_status,updated_at
       FROM knowledge_documents
      WHERE tenant_id=$1 AND document_id=$2
        AND status IN ('active','inactive')
        AND scan_status IN ('clean','not_required')
        AND parse_status IN ('parsed','ready')`,
    [tenantId, documentId]
  );
  return result.rows[0];
}

async function getKnowledgeDocumentPreview(response: ServerResponse, auth: AuthContext, requestId: string, documentId: string) {
  const document = await readableKnowledgeDocument(auth.tenant_id, documentId);
  if (!document) return respond(response, 404, requestId, errorBody("knowledge_document_not_found", "知识文档不存在或尚未完成安全处理"));
  const previewLimit = 200_000;
  response.setHeader("cache-control", "private, no-store");
  return respond(response, 200, requestId, { data: {
    document_id: document.document_id,
    title: document.title,
    source_type: document.source_type,
    version: document.version,
    status: document.status,
    content_format: document.content_format,
    original_filename: document.original_filename ? readableUploadFilename(document.original_filename) : null,
    file_size: document.file_size,
    ingestion_status: document.ingestion_status,
    scan_status: document.scan_status,
    parse_status: document.parse_status,
    updated_at: document.updated_at,
    preview_text: document.content.slice(0, previewLimit),
    preview_characters: document.content.length,
    preview_truncated: document.content.length > previewLimit,
    download_available: !document.storage_key || document.storage_key.startsWith("clean/")
  } });
}

function safeDownloadName(document: ReadableKnowledgeDocument, generatedText: boolean): string {
  const raw = generatedText ? `${document.title}.txt` : (document.original_filename ?? `${document.title}.txt`);
  const normalized = readableUploadFilename(raw).normalize("NFKC").replace(/[\\/\r\n\0"]/g, "_").trim().slice(0, 180);
  return normalized || "knowledge-document.txt";
}

function downloadMime(document: ReadableKnowledgeDocument, generatedText: boolean): string {
  if (generatedText) return "text/plain; charset=utf-8";
  const byFormat: Record<string, string> = {
    text: "text/plain; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    markdown: "text/markdown; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  };
  return byFormat[document.content_format] ?? "application/octet-stream";
}

async function downloadKnowledgeDocument(response: ServerResponse, auth: AuthContext, requestId: string, documentId: string) {
  const document = await readableKnowledgeDocument(auth.tenant_id, documentId);
  if (!document) return respond(response, 404, requestId, errorBody("knowledge_document_not_found", "知识文档不存在或尚未完成安全处理"));
  const generatedText = !document.storage_key;
  if (!generatedText && !document.storage_key?.startsWith("clean/")) {
    return respond(response, 409, requestId, errorBody("knowledge_source_unavailable", "原始文件尚未完成安全处理或不可下载"));
  }
  const bytes = generatedText ? Buffer.from(document.content, "utf8") : await readStored(document.storage_key!);
  const filename = safeDownloadName(document, generatedText);
  const fallback = filename.replace(/[^\x20-\x7E]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const actor = auditActor(auth);
  await pool.query(
    `INSERT INTO audit_logs
      (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
     VALUES ($1,$2,$3,'knowledge.document.downloaded','knowledge_document',$4,
             jsonb_build_object('version',$5::int,'generated_text',$6::boolean,'bytes',$7::int),$8)`,
    [auth.tenant_id, actor.type, actor.id, document.document_id, document.version, generatedText, bytes.length, requestId]
  );
  response.writeHead(200, {
    "content-type": downloadMime(document, generatedText),
    "content-length": String(bytes.length),
    "content-disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId
  });
  response.end(bytes);
}

export async function handlePhase4Api(
  request: IncomingMessage, response: ServerResponse, url: URL, auth: AuthContext, requestId: string
): Promise<boolean> {
  if (url.pathname === '/api/v1/ai/provider-settings' && request.method === 'GET') {
    await getProviderSettings(response, auth, requestId);
    return true;
  }
  if (url.pathname === '/api/v1/ai/tools/get-order' && request.method === 'POST') {
    await getOrderToolApi(request, response, auth, requestId);
    return true;
  }
  if (url.pathname === '/api/v1/ai/provider-settings' && request.method === 'PATCH') {
    await patchProviderSettings(request, response, auth, requestId);
    return true;
  }
  if (url.pathname === '/api/v1/ai/knowledge/documents' && request.method === 'POST') {
    await createKnowledgeDocument(request, response, auth, requestId);
    return true;
  }
  if(await handleKnowledgeDocumentApi(request,response,url,auth,requestId))return true;
  if(await handleKnowledgeDraftApi(request,response,url,auth,requestId))return true;
  if (url.pathname === '/api/v1/ai/knowledge/files' && request.method === 'POST') {
    await createKnowledgeFile(request, response, auth, requestId);
    return true;
  }
  const knowledgeDownloadMatch = url.pathname.match(/^\/api\/v1\/ai\/knowledge\/documents\/([0-9a-f-]{36})\/download$/i);
  if (knowledgeDownloadMatch && request.method === 'GET') {
    await downloadKnowledgeDocument(response, auth, requestId, knowledgeDownloadMatch[1]);
    return true;
  }
  const knowledgeDocumentMatch = url.pathname.match(/^\/api\/v1\/ai\/knowledge\/documents\/([0-9a-f-]{36})$/i);
  if (knowledgeDocumentMatch && request.method === 'GET') {
    await getKnowledgeDocumentPreview(response, auth, requestId, knowledgeDocumentMatch[1]);
    return true;
  }
  const knowledgeIndexMatch = url.pathname.match(/^\/api\/v1\/ai\/knowledge\/documents\/([0-9a-f-]{36})\/index$/i);
  if (knowledgeIndexMatch && request.method === 'POST') {
    await indexKnowledge(request, response, auth, requestId, knowledgeIndexMatch[1]);
    return true;
  }
  const knowledgeJobMatch = url.pathname.match(/^\/api\/v1\/ai\/knowledge\/jobs\/([0-9a-f-]{36})$/i);
  if (knowledgeJobMatch && request.method === 'GET') {
    await getKnowledgeJob(response, auth, requestId, knowledgeJobMatch[1]);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/ai/recommendations') {
    try{await createRecommendation(request, response, auth, requestId);}catch(e){if(e instanceof AiPointsError)respond(response,429,requestId,{error:{code:e.code,message:e.code==='ai_points_insufficient'?'AI 点数不足，请前往套餐与账务补充点数':'AI 点数暂不可用，请稍后重试'}});else throw e;}
    return true;
  }
  const recommendationMatch = url.pathname.match(/^\/api\/v1\/ai\/recommendations\/([0-9a-f-]{36})$/i);
  if (recommendationMatch && request.method === 'GET') {
    await getRecommendation(response, auth, requestId, recommendationMatch[1]);
    return true;
  }
  const actionMatch = url.pathname.match(/^\/api\/v1\/ai\/recommendations\/([0-9a-f-]{36})\/actions$/i);
  if (actionMatch && request.method === 'POST') {
    await recordAction(request, response, auth, requestId, actionMatch[1]);
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/ai/policies') {
    const policies = await pool.query(
      `SELECT policy_id,name,policy_type,status,priority,valid_from,valid_until,timezone,
              eligibility_time_basis,scope,decision,requires_human_approval,version
         FROM temporary_policies WHERE tenant_id=$1 ORDER BY priority DESC,updated_at DESC`, [auth.tenant_id]
    );
    respond(response, 200, requestId, { data: policies.rows });
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/ai/knowledge') {
    try{respond(response,200,requestId,await listKnowledgePage(pool,auth.tenant_id,url.searchParams.get('cursor')??undefined,url.searchParams.get('kind')??undefined,url.searchParams.get('filter')==='expiring'));}
    catch(error){if(!(error instanceof KnowledgeCursorError))throw error;respond(response,400,requestId,{error:{code:'invalid_knowledge_cursor',message:'分页位置无效，请返回第一页'}});}
    return true;
  }
  return false;
}
