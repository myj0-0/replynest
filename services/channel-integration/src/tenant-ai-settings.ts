import { pool } from "./database.js";
import type { Pool } from "pg";

export const llmProviders = ["deterministic", "deepseek", "qwen"] as const;
export const embeddingProviders = ["none", "gemini", "qwen"] as const;

export type LlmProviderName = typeof llmProviders[number];
export type EmbeddingProviderName = typeof embeddingProviders[number];

export type TenantAiSettings = {
  tenant_id: string;
  llm_provider: LlmProviderName;
  llm_model: string;
  llm_credential_ref: string | null;
  embedding_provider: EmbeddingProviderName;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  embedding_credential_ref: string | null;
  updated_at: string;
};

export async function getTenantAiSettings(tenantId: string, database: Pick<Pool,'query'> = pool): Promise<TenantAiSettings> {
  const result = await database.query<TenantAiSettings>(
    `SELECT tenant_id,llm_provider,llm_model,llm_credential_ref,
            embedding_provider,embedding_model,embedding_dimensions,embedding_credential_ref,updated_at
       FROM tenant_ai_settings WHERE tenant_id=$1`,
    [tenantId]
  );
  let settings=result.rows[0];
  if(!settings){
    // Older/pilot workspaces may have no settings row. Read defaults only for an
    // existing usable workspace; never create consent or enable reception here.
    const tenant=await database.query<{tenant_id:string;updated_at:string}>(
      "SELECT tenant_id,created_at::text updated_at FROM tenants WHERE tenant_id=$1 AND status IN ('active','test')",[tenantId]);
    if(!tenant.rows[0])throw new Error('ai_settings_unavailable');
    settings={...tenant.rows[0],llm_provider:'deterministic',llm_model:'deterministic-phase4-sample',
      llm_credential_ref:null,embedding_provider:'none',embedding_model:null,embedding_dimensions:null,embedding_credential_ref:null};
  }
  if(process.env.QWEN_UNIFIED_ENABLED==='true')return {...settings,llm_provider:'qwen',llm_model:'qwen3.8-flash',llm_credential_ref:'platform/qwen',embedding_provider:'qwen',embedding_model:'qwen3.7-text-embedding-flash',embedding_dimensions:768,embedding_credential_ref:'platform/qwen'};
  return settings;
}

export function validateTenantAiSettings(input: Record<string, unknown>) {
  const allowed = new Set([
    "llm_provider", "llm_model", "llm_credential_ref", "embedding_provider",
    "embedding_model", "embedding_dimensions", "embedding_credential_ref"
  ]);
  if (Object.keys(input).some(key => !allowed.has(key))) return "包含不支持的配置字段";
  if (input.llm_provider !== undefined && !llmProviders.includes(input.llm_provider as LlmProviderName)) return "不支持的 LLM Provider";
  if (input.embedding_provider !== undefined && !embeddingProviders.includes(input.embedding_provider as EmbeddingProviderName)) return "不支持的 Embedding Provider";
  if (input.llm_model !== undefined && (typeof input.llm_model !== "string" || !input.llm_model.trim() || input.llm_model.length > 100)) return "llm_model 不合法";
  if (input.embedding_model !== undefined && input.embedding_model !== null && (typeof input.embedding_model !== "string" || !input.embedding_model.trim() || input.embedding_model.length > 100)) return "embedding_model 不合法";
  if (input.embedding_dimensions !== undefined && input.embedding_dimensions !== null && Number(input.embedding_dimensions) !== 768) return "当前平台统一使用 768 维向量；切换 Provider 时需要保持维度一致并重新索引";
  for (const key of ["llm_credential_ref", "embedding_credential_ref"] as const) {
    if (input[key] !== undefined && input[key] !== null && (typeof input[key] !== "string" || !["platform/deepseek", "platform/gemini"].includes(input[key]))) return `${key} 不合法`;
  }
  return undefined;
}
