import assert from "node:assert/strict";
import test from "node:test";
import { inboundRetryDelaySeconds, safeInboundFailure } from "./inbound-queue-core.js";

test("inbound retry uses bounded exponential backoff", () => {
  assert.equal(inboundRetryDelaySeconds(1), 5);
  assert.equal(inboundRetryDelaySeconds(4), 40);
  assert.equal(inboundRetryDelaySeconds(20), 300);
});

test("inbound failures do not retain upstream response bodies", () => {
  const failure = safeInboundFailure(new Error("POST http://rails/private returned 500: customer-secret"));
  assert.equal(failure.code, "transient_processing_failure");
  assert.equal(failure.detail.includes("customer-secret"), false);
});

test("permanent upstream rejection is sent directly to DLQ", () => {
  assert.equal(safeInboundFailure(new Error("POST upstream returned 422: bad")).code, "permanent_upstream_rejection");
  assert.equal(safeInboundFailure(new Error("POST upstream returned 429: busy")).code, "transient_processing_failure");
});
