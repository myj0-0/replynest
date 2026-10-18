import assert from "node:assert/strict";
import test from "node:test";
import { decideTrialEligibility, trialWindow, validateTrialBenefit } from "./trial-core.js";

const benefit = { trial_days: 14, grace_days: 7, seat_limit: 3, message_limit: 5000, knowledge_bytes: 1024, features: ["ai_copilot"], grants: [{ account: "gift", currency: "CNY", amount_minor: 3000 }] };

test("trial benefit is versioned data and validates bounded grants", () => {
  assert.equal(validateTrialBenefit(benefit).trial_days, 14);
  assert.throws(() => validateTrialBenefit({ ...benefit, trial_days: 0 }));
  assert.throws(() => validateTrialBenefit({ ...benefit, grants: [...benefit.grants, ...benefit.grants] }));
});

test("verified low-risk tenant is eligible", () => {
  assert.deepEqual(decideTrialEligibility({ has_verified_contact: true, prior_trial: false, shared_admin: false, shared_verified_phone: false, shared_organization: false, risk_state: "clear" }), { outcome: "eligible", reason_codes: ["new_verified_tenant"] });
});

test("unverified contact is rejected and medium risk is reviewed", () => {
  assert.equal(decideTrialEligibility({ has_verified_contact: false, prior_trial: false, shared_admin: false, shared_verified_phone: false, shared_organization: false, risk_state: "clear" }).outcome, "rejected");
  assert.equal(decideTrialEligibility({ has_verified_contact: true, prior_trial: false, shared_admin: false, shared_verified_phone: false, shared_organization: false, risk_state: "review" }).outcome, "review");
});

test("high-confidence reuse is rejected without relying on IP", () => {
  const result = decideTrialEligibility({ has_verified_contact: true, prior_trial: false, shared_admin: true, shared_verified_phone: false, shared_organization: true, risk_state: "clear" });
  assert.equal(result.outcome, "rejected");
  assert.deepEqual(result.reason_codes, ["admin_used_trial_elsewhere", "organization_used_trial_elsewhere"]);
});

test("trial and grace windows are deterministic", () => {
  const result = trialWindow(new Date("2026-09-03T00:00:00.000Z"), validateTrialBenefit(benefit));
  assert.equal(result.ends_at, "2026-09-17T00:00:00.000Z");
  assert.equal(result.grace_ends_at, "2026-09-24T00:00:00.000Z");
});
