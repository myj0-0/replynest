import { secretValue } from "./secret-value.js";

const platformCredentials: Record<string, string> = {
  "platform/deepseek": "DEEPSEEK_API_KEY",
  "platform/gemini": "GEMINI_API_KEY"
};

export function resolveCredential(reference: string | null): string | undefined {
  if (!reference) return undefined;
  if(reference==='platform/qwen')return secretValue('QWEN_API_KEY')||secretValue('EXTENSION_QWEN_API_KEY');
  const environmentName = platformCredentials[reference];
  if (!environmentName) return undefined;
  return secretValue(environmentName);
}

export function credentialAvailable(reference: string | null): boolean {
  return Boolean(resolveCredential(reference));
}
