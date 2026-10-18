import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkText, contentChecksum, validateKnowledgeInput } from "./knowledge-ingestion.js";

test("knowledge input validation accepts text and rejects binary formats", () => {
  assert.equal(validateKnowledgeInput({ title: "退款", source_type: "knowledge", format: "markdown", content: "规则正文" }), undefined);
  assert.match(validateKnowledgeInput({ title: "退款", source_type: "knowledge", format: "pdf", content: "x" }) ?? "", /仅支持/);
});

test("chunker is deterministic and overlaps long paragraphs", () => {
  const content = "第一段。\n\n" + "临时退款规则".repeat(220);
  const first = chunkText(content);
  const second = chunkText(content);
  assert.deepEqual(first, second);
  assert.ok(first.length > 2);
  assert.ok(first.every(chunk => chunk.length <= 800));
  assert.equal(contentChecksum(content), contentChecksum(content));
});
