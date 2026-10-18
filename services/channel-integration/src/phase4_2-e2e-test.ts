import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { requiredEnv } from "./shared.js";

const baseUrl = process.env.PHASE4_API_URL ?? "http://channel-gateway:3001";
const fixtureDir = process.env.PHASE4_2_FIXTURE_DIR ?? "/fixtures";
const isolationKey = requiredEnv("ISOLATION_TEST_TENANT_API_KEY");
const demoKey = requiredEnv("DEMO_TENANT_API_KEY");
const expectEmbeddings = process.env.EXPECT_EMBEDDINGS === "1";

async function api(url: string, key: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${url}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000)
  });
}

async function upload(filename: string, mimeType: string, supplied?: Uint8Array, title?: string) {
  const form = new FormData();
  form.set("title", title ?? `Phase 4.2 synthetic ${filename} ${randomUUID()}`);
  form.set("source_type", "knowledge");
  const raw = supplied ?? await readFile(path.join(fixtureDir, filename));
  const arrayBuffer = new ArrayBuffer(raw.byteLength);
  new Uint8Array(arrayBuffer).set(raw);
  form.set("file", new Blob([arrayBuffer], { type: mimeType }), filename);
  const response = await api("/api/v1/ai/knowledge/files", isolationKey, {
    method: "POST", headers: { "idempotency-key": randomUUID() }, body: form
  });
  const body = await response.json() as any;
  assert.equal(response.status, 202, JSON.stringify(body));
  return body.data;
}

async function waitForJob(jobId: string) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await api(`/api/v1/ai/knowledge/jobs/${jobId}`, isolationKey);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    if (["succeeded", "dead"].includes(body.data.status)) return body.data;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.fail(`Job ${jobId} did not finish within 45 seconds`);
}

const formats = [
  ["synthetic-policy.txt", "text/plain"],
  ["synthetic-policy.pdf", "application/pdf"],
  ["synthetic-policy.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
] as const;
const stableTitle = `Phase 4.2 atomic version ${randomUUID()}`;
const accepted: Array<{ documentId: string; jobId: string }> = [];
for (const [index, [filename, mime]] of formats.entries()) {
  const created = await upload(filename, mime, undefined, index === 0 ? stableTitle : undefined);
  const job = await waitForJob(created.job.job_id);
  assert.equal(job.status, "succeeded", JSON.stringify(job));
  assert.ok(["parsed", "ready"].includes(job.result.status), JSON.stringify(job));
  assert.ok(job.result.chunks > 0, JSON.stringify(job));
  accepted.push({ documentId: created.document_id, jobId: created.job.job_id });
}

// Build the standard harmless antivirus test signature in memory so host antivirus does not quarantine a fixture file.
const eicarBytes = Uint8Array.from(Buffer.from([
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$",
  "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
].join(""), "ascii"));
const eicar = await upload("eicar-test.txt", "text/plain", eicarBytes, stableTitle);
const rejected = await waitForJob(eicar.job.job_id);
assert.equal(rejected.status, "dead", JSON.stringify(rejected));
assert.equal(rejected.result.status, "infected");

const documentsResponse = await api("/api/v1/ai/knowledge", isolationKey);
const documents = (await documentsResponse.json() as any).data as any[];
for (const item of accepted) {
  const document = documents.find(candidate => candidate.document_id === item.documentId);
  assert.equal(document.scan_status, "clean");
  assert.equal(document.parse_status, "parsed");
  assert.ok(document.chunk_count > 0);
  if (expectEmbeddings) {
    assert.equal(document.ingestion_status, "ready");
    assert.ok(document.ready_chunk_count > 0);
  }
}
const infected = documents.find(candidate => candidate.document_id === eicar.document_id);
assert.equal(infected.scan_status, "infected");
assert.equal(infected.parse_status, "blocked");
assert.equal(infected.status, "inactive");
assert.equal(documents.find(candidate => candidate.document_id === accepted[0].documentId).status, "active");

const previewResponse = await api(`/api/v1/ai/knowledge/documents/${accepted[0].documentId}`, isolationKey);
assert.equal(previewResponse.status, 200);
const preview = await previewResponse.json() as any;
assert.match(preview.data.preview_text, /NOVA-TXT/);
assert.equal(preview.data.preview_truncated, false);
assert.equal(preview.data.download_available, true);
assert.equal(Object.hasOwn(preview.data, "storage_key"), false);

const downloadResponse = await api(`/api/v1/ai/knowledge/documents/${accepted[0].documentId}/download`, isolationKey);
assert.equal(downloadResponse.status, 200);
assert.match(downloadResponse.headers.get("content-disposition") ?? "", /attachment/);
assert.equal(downloadResponse.headers.get("cache-control"), "private, no-store");
assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), await readFile(path.join(fixtureDir, "synthetic-policy.txt")));

const crossTenantPreview = await api(`/api/v1/ai/knowledge/documents/${accepted[0].documentId}`, demoKey);
assert.equal(crossTenantPreview.status, 404);
const crossTenantDownload = await api(`/api/v1/ai/knowledge/documents/${accepted[0].documentId}/download`, demoKey);
assert.equal(crossTenantDownload.status, 404);
const infectedPreview = await api(`/api/v1/ai/knowledge/documents/${eicar.document_id}`, isolationKey);
assert.equal(infectedPreview.status, 404);
const infectedDownload = await api(`/api/v1/ai/knowledge/documents/${eicar.document_id}/download`, isolationKey);
assert.equal(infectedDownload.status, 404);

const crossTenantJob = await api(`/api/v1/ai/knowledge/jobs/${accepted[0].jobId}`, demoKey);
assert.equal(crossTenantJob.status, 404);

let semanticRetrieval = false;
if (expectEmbeddings) {
  const customerResponse = await api("/api/v1/customers?limit=1", isolationKey);
  const customerId = (await customerResponse.json() as any).data[0].customer_id;
  const recommendationResponse = await api("/api/v1/ai/recommendations", isolationKey, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
    body: JSON.stringify({ customer_id: customerId, question: "How long is the complimentary exchange period?", context: {} })
  });
  const recommendation = await recommendationResponse.json() as any;
  assert.equal(recommendationResponse.status, 201, JSON.stringify(recommendation));
  semanticRetrieval = recommendation.data.knowledge_citations.some((citation: any) =>
    accepted.some(item => item.documentId === citation.document_id) && citation.retrieval === "semantic"
  );
  assert.equal(semanticRetrieval, true, JSON.stringify(recommendation.data.knowledge_citations));
}

console.log(JSON.stringify({
  multipart_formats: formats.map(([filename]) => path.extname(filename).slice(1)),
  clean_documents: accepted.length,
  embeddings_ready: expectEmbeddings,
  semantic_retrieval: semanticRetrieval,
  malware_blocked: true,
  failed_version_preserves_active: true,
  cross_tenant_job_hidden: true,
  tenant_scoped_preview: true,
  clean_original_download: true,
  quarantined_and_infected_hidden: true
}));
