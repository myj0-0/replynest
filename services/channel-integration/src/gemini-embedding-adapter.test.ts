import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { embedWithGemini } from "./gemini-embedding-adapter.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("Gemini embedding adapter requests tenant-selected dimensions and normalizes reduced vectors", async () => {
  let sentBody = "";
  globalThis.fetch = async (_url, init) => {
    sentBody = String(init?.body);
    return new Response(JSON.stringify({ embedding: { values: Array(768).fill(1) } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const vector = await embedWithGemini({
    apiKey: "test-key",
    model: "gemini-embedding-001",
    text: "退款规则",
    dimensions: 768,
    task: "RETRIEVAL_DOCUMENT",
    title: "退款说明"
  });
  assert.equal(vector.length, 768);
  assert.ok(Math.abs(Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) - 1) < 1e-10);
  assert.match(sentBody, /outputDimensionality/);
  assert.match(sentBody, /RETRIEVAL_DOCUMENT/);
  assert.doesNotMatch(sentBody, /test-key/);
  const parsed = JSON.parse(sentBody);
  assert.equal(parsed.outputDimensionality, 768);
  assert.equal(parsed.embedContentConfig, undefined);
});
