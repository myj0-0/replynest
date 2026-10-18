import assert from "node:assert/strict";
import test from "node:test";
import { inviterEligibility, normalizeInviteCode, paymentQualification, validateReferralRules } from "./referral-core.js";

const rules = validateReferralRules({ inviter_billing_status: "paid", min_account_age_days: 7, min_lifetime_cash_paid_minor: 10000, attribution_window_minutes: 30, min_first_cash_payment_minor: 10000, observation_days: 7 });

test("referral rules are bounded versioned data", () => {
  assert.equal(rules.observation_days, 7);
  assert.throws(() => validateReferralRules({ ...rules, observation_days: 0 }));
});

test("only an established paid inviter is eligible", () => {
  assert.equal(inviterEligibility({ billing_status: "paid", account_age_days: 8, lifetime_cash_paid_minor: 10000, risk_restricted: false }, rules).eligible, true);
  assert.deepEqual(inviterEligibility({ billing_status: "trial", account_age_days: 1, lifetime_cash_paid_minor: 0, risk_restricted: true }, rules).reason_codes, ["paid_tenant_required", "account_age_too_short", "cash_spend_below_threshold", "inviter_risk_restricted"]);
});

test("cash threshold starts a deterministic observation period", () => {
  assert.equal(paymentQualification(9999, "CNY", new Date("2026-09-04T00:00:00Z"), rules).accepted, false);
  assert.equal(paymentQualification(10000, "CNY", new Date("2026-09-04T00:00:00Z"), rules).observation_ends_at, "2026-09-11T00:00:00.000Z");
  assert.throws(() => paymentQualification(10000, "USD", new Date(), rules));
});

test("invite code reveals no tenant identifier and has strict syntax", () => {
  assert.equal(normalizeInviteCode("Abcdefghijklmnop_1234"), "Abcdefghijklmnop_1234");
  assert.throws(() => normalizeInviteCode("tenant-a"));
});
