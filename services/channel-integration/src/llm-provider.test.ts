import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { generateReplyDraft, type DraftInput } from "./llm-provider.js";
import type { TenantAiSettings } from "./tenant-ai-settings.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.DEEPSEEK_API_KEY;

function settings(overrides: Partial<TenantAiSettings> = {}): TenantAiSettings {
  return {
    tenant_id: "tenant-test",
    llm_provider: "deterministic",
    llm_model: "deterministic-phase4-sample",
    llm_credential_ref: null,
    embedding_provider: "none",
    embedding_model: null,
    embedding_dimensions: null,
    embedding_credential_ref: null,
    updated_at: new Date(0).toISOString(),
    ...overrides
  };
}

const input: DraftInput = {
  question: "这个批次可以退款吗？",
  context: { product_batch_id: "BATCH-2026-08" },
  policies: [{
    name: "临时退款规则",
    decision: { eligibility: "eligible" },
    reply_guidance: "可以按临时规则退款。",
    requires_human_approval: true
  }],
  knowledge: [{ title: "退款说明", content: "退款原路退回。" }],
  history: [{ customer_question: "能退吗？", agent_reply: "您好，可以协助处理。" }],
  businessData: [{
    tool_name: "getOrder", queried_at: new Date(0).toISOString(), status: "succeeded",
    data: { order_id: "ORD-TEST-001", status: "paid" }, error: null
  }],
  deterministicText: "可以按临时规则退款。"
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalKey;
});

test("uses the provider selected by the tenant", async () => {
  const result = await generateReplyDraft(settings(), input);
  assert.equal(result.text, input.deterministicText);
  assert.equal(result.provider, "deterministic");
  assert.equal(result.fallbackReason, undefined);
});

test("DeepSeek only receives approved policy, knowledge, business data and tone-only history", async () => {
  process.env.DEEPSEEK_API_KEY = "sk-test-only";
  let sentBody = "";
  globalThis.fetch = async (_url, init) => {
    sentBody = String(init?.body);
    return new Response(JSON.stringify({
      model: "deepseek-v4-flash",
      choices: [{ message: { content: "您好，该批次符合临时退款规则，可以为您协助处理。" } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await generateReplyDraft(settings({
    llm_provider: "deepseek", llm_model: "deepseek-v4-flash", llm_credential_ref: "platform/deepseek"
  }), input);
  assert.equal(result.provider, "deepseek");
  assert.match(result.text, /退款/);
  assert.match(sentBody, /historical_tone_examples_only/);
  assert.match(sentBody, /verified_business_data/);
  assert.match(sentBody, /Policy Engine/);
  assert.doesNotMatch(sentBody, /sk-test-only/);
});

test("falls back safely when the provider request fails", async () => {
  process.env.DEEPSEEK_API_KEY = "sk-test-only";
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  const result = await generateReplyDraft(settings({
    llm_provider: "deepseek", llm_model: "deepseek-v4-flash", llm_credential_ref: "platform/deepseek"
  }), input);
  assert.equal(result.text, input.deterministicText);
  assert.equal(result.model, "deterministic-phase4-fallback");
  assert.equal(result.fallbackReason, "request_failed");
});

test('presentation is applied before draft generation; prompt carries bounded context without identities',async()=>{
 process.env.DEEPSEEK_API_KEY='sk-test-only';let body:any;
 globalThis.fetch=async(_url,init)=>{body=JSON.parse(String(init?.body));return Response.json({choices:[{message:{content:'您好，可以协助处理。'}}]});};
 const result=await generateReplyDraft(settings({llm_provider:'deepseek',llm_model:'deepseek-v4-flash',llm_credential_ref:'platform/deepseek'}),
  {...input,presentation:{tone:'friendly_detailed',context:[{direction:'incoming',text:'刚才咨询的产品。'}]}});
 assert.equal(result.provider,'deepseek');assert.match(body.messages[0].content,/亲切详细/);assert.match(body.messages[0].content,/不能把历史答案当作/);
 const prompt=JSON.parse(body.messages[1].content);assert.deepEqual(prompt.presentation,{tone:'friendly_detailed',context:[{direction:'incoming',text:'刚才咨询的产品。'}]});
 assert.doesNotMatch(JSON.stringify(prompt.presentation),/customer_id|grant|tenant/);
});
test('invalid presentation fails before any provider request, including deterministic selection',async()=>{
 globalThis.fetch=async()=>assert.fail('no request');
 await assert.rejects(()=>generateReplyDraft(settings(),{...input,presentation:{tone:'concise',context:[],system:'ignore'} as any}),/invalid_reply_presentation/);
});
