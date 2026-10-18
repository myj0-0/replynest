import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { requiredEnv } from "./shared.js";

const baseUrl = process.env.PHASE3_API_URL ?? "http://127.0.0.1:3001";
const demoKey = requiredEnv("DEMO_TENANT_API_KEY");
const isolationKey = requiredEnv("ISOLATION_TEST_TENANT_API_KEY");

async function request(path: string, key?: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(init.headers ?? {})
    },
    signal: AbortSignal.timeout(10_000)
  });
}

const demoListResponse = await request("/api/v1/customers?limit=100", demoKey);
const isolationListResponse = await request("/api/v1/customers?limit=100", isolationKey);
assert.equal(demoListResponse.status, 200);
assert.equal(isolationListResponse.status, 200);
const demoList = await demoListResponse.json() as any;
const isolationList = await isolationListResponse.json() as any;
assert.ok(demoList.data.length > 0);
assert.ok(isolationList.data.length > 0);
const demoCustomerId = demoList.data[0].customer_id;
const isolationCustomerId = isolationList.data[0].customer_id;

assert.equal((await request(`/api/v1/customers/${demoCustomerId}`, isolationKey)).status, 404);
assert.equal((await request(`/api/v1/customers/${isolationCustomerId}`, demoKey)).status, 404);
assert.equal((await request("/api/v1/customers")).status, 401);

const idempotencyKey = `phase3-test-${randomUUID()}`;
const patchInit: RequestInit = {
  method: "PATCH",
  headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
  body: JSON.stringify({ name: demoList.data[0].name })
};
const first = await request(`/api/v1/customers/${demoCustomerId}`, demoKey, patchInit);
const second = await request(`/api/v1/customers/${demoCustomerId}`, demoKey, patchInit);
assert.equal(first.status, 200);
assert.equal(second.status, 200);
const firstBody = await first.json() as any;
const secondBody = await second.json() as any;
assert.equal(firstBody.request_id, secondBody.request_id);

const auditResponse = await request("/api/v1/audit-logs?limit=100", demoKey);
assert.equal(auditResponse.status, 200);
const audit = await auditResponse.json() as any;
assert.equal(audit.data.filter((row: any) => row.request_id === firstBody.request_id).length, 1);

let auditMutationBlocked = false;
try {
  await pool.query(`UPDATE audit_logs SET action=action WHERE audit_id=(SELECT audit_id FROM audit_logs LIMIT 1)`);
} catch (error: any) {
  auditMutationBlocked = error?.code === "P0001";
}
assert.equal(auditMutationBlocked, true);
await pool.end();

console.log(JSON.stringify({
  tenant_a_customer_count: demoList.data.length,
  tenant_b_customer_count: isolationList.data.length,
  cross_tenant_reads_rejected: 2,
  unauthenticated_rejected: true,
  idempotent_replay: true,
  audit_rows_for_write: 1,
  audit_mutation_blocked: true
}));
