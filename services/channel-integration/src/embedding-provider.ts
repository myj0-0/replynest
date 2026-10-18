import { resolveCredential } from "./credential-resolver.js";
import { embedWithGemini, type EmbeddingTask } from "./gemini-embedding-adapter.js";
import type { TenantAiSettings } from "./tenant-ai-settings.js";
import {qwenEmbedding} from './qwen-runtime.js';
import {meteredAi} from './ai-metered.js';

export type EmbeddingResult = { provider: string; model: string; dimensions: number; vector: number[] };

export async function embedText(
  settings: TenantAiSettings,
  text: string,
  task: EmbeddingTask,
  title?: string
): Promise<EmbeddingResult | undefined> {
  if(settings.embedding_provider==='qwen'){
    const r=await meteredAi(settings.tenant_id,task==='RETRIEVAL_QUERY'?'embedding_query':'embedding_document',text,0,()=>qwenEmbedding(text));
    return {provider:'qwen',model:r.model,dimensions:r.dimensions,vector:r.vector};
  }
  if (settings.embedding_provider === "none" || !settings.embedding_model || !settings.embedding_dimensions) return undefined;
  const apiKey = resolveCredential(settings.embedding_credential_ref);
  if (!apiKey) return undefined;
  if (settings.embedding_provider === "gemini") {
    const dimensions = settings.embedding_dimensions as 768;
    const vector = await embedWithGemini({ apiKey, model: settings.embedding_model, text, dimensions, task, title });
    return { provider: "gemini", model: settings.embedding_model, dimensions, vector };
  }
  return undefined;
}

export function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
