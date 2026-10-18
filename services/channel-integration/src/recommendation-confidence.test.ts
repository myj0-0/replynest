import test from "node:test";
import assert from "node:assert/strict";
import { assessRecommendationConfidence } from "./recommendation-confidence.js";

test("history never raises recommendation confidence", () => {
  const withoutHistory = assessRecommendationConfidence({ status: "insufficient_evidence", policies: [], knowledge: [], toolResults: [], historyCount: 0 });
  const withHistory = assessRecommendationConfidence({ status: "insufficient_evidence", policies: [], knowledge: [], toolResults: [], historyCount: 5 });
  assert.equal(withHistory.score, withoutHistory.score);
  assert.equal(withHistory.level, "low");
});

test("policy, knowledge and successful business data produce high evidence confidence", () => {
  const result = assessRecommendationConfidence({
    status: "generated",
    policies: [{ requires_human_approval: false }],
    knowledge: [{ retrieval: "semantic", score: 0.76 }],
    toolResults: [{ status: "succeeded" }],
    historyCount: 1
  });
  assert.equal(result.level, "high");
  assert.equal(result.auto_reply_candidate, true);
  assert.equal(result.delivery_mode, "human_confirmation");
});

test("human approval rule prevents automatic reply candidacy", () => {
  const result = assessRecommendationConfidence({
    status: "generated",
    policies: [{ requires_human_approval: true }],
    knowledge: [{ retrieval: "semantic", score: 0.8 }],
    toolResults: [{ status: "succeeded" }],
    historyCount: 0
  });
  assert.equal(result.level, "high");
  assert.equal(result.auto_reply_candidate, false);
});

test("policy conflict is always blocked with zero confidence", () => {
  const result = assessRecommendationConfidence({ status: "blocked_by_policy_conflict", policies: [{ requires_human_approval: false }], knowledge: [{ score: 1 }], toolResults: [{ status: "succeeded" }], historyCount: 0 });
  assert.equal(result.score, 0);
  assert.equal(result.auto_reply_candidate, false);
});

test("failed business lookup lowers confidence and blocks automation", () => {
  const result = assessRecommendationConfidence({ status: "generated", policies: [{ requires_human_approval: false }], knowledge: [], toolResults: [{ status: "not_found" }], historyCount: 0 });
  assert.equal(result.level, "low");
  assert.equal(result.auto_reply_candidate, false);
});
