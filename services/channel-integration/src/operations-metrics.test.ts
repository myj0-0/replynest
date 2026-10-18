import assert from "node:assert/strict";
import test from "node:test";
import { normalizeChatwootSummary, percentChange, safeRate } from "./operations-metrics-core.js";

test("metrics ratios preserve zero-denominator as unavailable", () => {
  assert.equal(safeRate(2, 5), 40);
  assert.equal(safeRate(0, 5), 0);
  assert.equal(safeRate(1, 0), null);
  assert.equal(percentChange(12, 10), 20);
  assert.equal(percentChange(1, 0), null);
});

test("Chatwoot summary is normalized without trusting malformed numbers", () => {
  assert.deepEqual(normalizeChatwootSummary({
    conversations_count: 4,
    avg_first_response_time: 35.5,
    resolutions_count: 3,
    previous: { conversations_count: 2, avg_first_response_time: null, resolutions_count: 1 }
  }), {
    conversations_count: 4,
    avg_first_response_time: 35.5,
    resolutions_count: 3,
    previous: { conversations_count: 2, avg_first_response_time: null, resolutions_count: 1 }
  });
  assert.equal(normalizeChatwootSummary({ conversations_count: "bad" }).conversations_count, 0);
});
