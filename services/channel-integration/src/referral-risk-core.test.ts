import assert from "node:assert/strict";
import test from "node:test";
import { assessReferralRisk, normalizeRiskSignal, riskSignalFingerprint, signalConfidence } from "./referral-risk-core.js";

test("risk signal fingerprints normalize without retaining raw identifiers", () => {
  const pepper = "phase-b4-test-pepper-at-least-thirty-two-characters";
  assert.equal(riskSignalFingerprint("verified_phone", "+86 138-0013-8000", pepper), riskSignalFingerprint("verified_phone", "+8613800138000", pepper));
  assert.match(riskSignalFingerprint("legal_entity", " 9135 abc ", pepper), /^[a-f0-9]{64}$/);
  assert.equal(normalizeRiskSignal("legal_entity", " 9135 abc "), "9135ABC");
});

test("high confidence matches reject while device matches require review", () => {
  assert.deepEqual(assessReferralRisk([{ signal_type: "payment_subject", confidence: signalConfidence("payment_subject") }]).outcome, "reject");
  assert.deepEqual(assessReferralRisk([{ signal_type: "device", confidence: signalConfidence("device") }]).outcome, "review");
});

test("an IP network alone cannot reject or force review", () => {
  const decision = assessReferralRisk([{ signal_type: "ip_network", confidence: signalConfidence("ip_network") }]);
  assert.equal(decision.outcome, "allow");
  assert.equal(decision.risk_score, 20);
});
