import test from "node:test";
import assert from "node:assert/strict";
import { availabilitySeries, availabilitySummary, combinedAvailabilitySeries, combinedAvailabilitySummary, recordAvailability } from "./availability.mjs";

const now = Date.parse("2026-09-12T10:00:00Z");

test("records real samples and calculates a bounded 90-day rate", () => {
  const history = {};
  recordAvailability(history, "console", true, now - 86_400_000);
  recordAvailability(history, "console", true, now);
  recordAvailability(history, "console", false, now);
  const summary = availabilitySummary(history, "console", now);
  assert.equal(summary.coverage_days, 2);
  assert.equal(summary.sample_count, 3);
  assert.equal(summary.rate_percent, 66.667);
  assert.equal(summary.monitoring_since, "2026-09-11");
});

test("prunes samples older than the declared window", () => {
  const history = {};
  recordAvailability(history, "gateway", true, now - 90 * 86_400_000);
  recordAvailability(history, "gateway", true, now);
  assert.deepEqual(Object.keys(history.gateway), ["2026-09-12"]);
});

test("combines only observed samples without inventing prior history", () => {
  const history = {};
  recordAvailability(history, "console", true, now);
  recordAvailability(history, "gateway", false, now);
  const summary = combinedAvailabilitySummary(history, ["console", "gateway"], now);
  assert.equal(summary.coverage_days, 1);
  assert.equal(summary.sample_count, 2);
  assert.equal(summary.rate_percent, 50);
});

test("returns fixed daily chart buckets and keeps unobserved dates empty", () => {
  const history = {};
  recordAvailability(history, "console", true, now);
  recordAvailability(history, "console", false, now);
  const series = availabilitySeries(history, "console", now, 3);
  assert.deepEqual(series.map(item => item.date), ["2026-09-10", "2026-09-11", "2026-09-12"]);
  assert.equal(series[0].rate_percent, null);
  assert.equal(series[2].rate_percent, 50);
  assert.equal(series[2].sample_count, 2);
});

test("combines daily chart buckets from critical targets only", () => {
  const history = {};
  recordAvailability(history, "console", true, now);
  recordAvailability(history, "gateway", false, now);
  recordAvailability(history, "optional", false, now);
  const series = combinedAvailabilitySeries(history, ["console", "gateway"], now, 2);
  assert.equal(series[0].rate_percent, null);
  assert.equal(series[1].rate_percent, 50);
  assert.equal(series[1].sample_count, 2);
});
