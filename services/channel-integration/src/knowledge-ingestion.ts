import { createHash } from "node:crypto";

export type KnowledgeFormat = "text" | "markdown";

export function validateKnowledgeInput(input: Record<string, unknown>): string | undefined {
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200) return "title 不能为空且不能超过 200 字符";
  if (!(["knowledge", "faq", "script", "temporary_policy_text"] as unknown[]).includes(input.source_type)) return "source_type 不合法";
  if (!(["text", "markdown"] as unknown[]).includes(input.format)) return "当前仅支持 text 和 markdown";
  if (typeof input.content !== "string" || !input.content.trim()) return "content 不能为空";
  if (Buffer.byteLength(input.content, "utf8") > 512 * 1024) return "单个文档不能超过 512 KiB";
  if (input.filename !== undefined && (typeof input.filename !== "string" || !/^[^\\/\0]{1,200}$/.test(input.filename))) return "filename 不合法";
  return undefined;
}

export function contentChecksum(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function chunkText(content: string, maxCharacters = 800, overlapCharacters = 100): string[] {
  const paragraphs = content.replace(/\r\n/g, "\n").split(/\n{2,}/).map(item => item.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxCharacters) {
      flush();
      const step = Math.max(1, maxCharacters - overlapCharacters);
      for (let offset = 0; offset < paragraph.length; offset += step) {
        chunks.push(paragraph.slice(offset, offset + maxCharacters));
        if (offset + maxCharacters >= paragraph.length) break;
      }
    } else if (!current) {
      current = paragraph;
    } else if (current.length + 2 + paragraph.length <= maxCharacters) {
      current += `\n\n${paragraph}`;
    } else {
      flush();
      current = paragraph;
    }
  }
  flush();
  return chunks;
}
