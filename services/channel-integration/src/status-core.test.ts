import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "./status-core.js";

test("status summary distinguishes optional degradation from critical outage", () => {
  assert.equal(summarize([{ id: "a", name: "A", status: "operational", latency_ms: 1, critical: true }]), "operational");
  assert.equal(summarize([{ id: "a", name: "A", status: "major_outage", latency_ms: 1, critical: false }]), "degraded");
  assert.equal(summarize([{ id: "a", name: "A", status: "major_outage", latency_ms: 1, critical: true }]), "major_outage");
});
