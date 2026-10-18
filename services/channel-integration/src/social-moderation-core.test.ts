import assert from "node:assert/strict";
import test from "node:test";
import {
  correctedSocialRoute,
  nextSocialCaseState,
  validateCorrectableCategory,
  validateModerationReason,
  socialObservedRate,
  validateSocialQualityWindow,
  validateSocialRuleName,
} from "./social-moderation-core.js";

test("social moderation validates rule names and human reasons", () => {
  assert.equal(validateSocialRuleName("  退款批次规则  "), "退款批次规则");
  assert.equal(validateModerationReason("坐席核对订单后确认属于售后问题"), "坐席核对订单后确认属于售后问题");
  assert.throws(() => validateSocialRuleName("x"), /invalid_social_rule_name/);
  assert.throws(() => validateModerationReason("太短"), /invalid_social_moderation_reason/);
});

test("quality windows and observed rates fail closed", () => {
  assert.equal(validateSocialQualityWindow(undefined), 30);
  assert.equal(validateSocialQualityWindow("90"), 90);
  assert.throws(() => validateSocialQualityWindow(14), /invalid_social_quality_window/);
  assert.equal(socialObservedRate(3, 4), 0.75);
  assert.equal(socialObservedRate(0, 0), null);
  assert.throws(() => socialObservedRate(2, 1), /invalid_social_quality_counts/);
});

test("human correction cannot use unknown and recalculates routing", () => {
  assert.equal(validateCorrectableCategory("after_sales"), "after_sales");
  assert.throws(() => validateCorrectableCategory("unknown"), /invalid_social_correction_category/);
  assert.deepEqual(correctedSocialRoute("comment.created", "public_crisis"), {
    route: "escalate",
    priority: "urgent",
    requires_human: true,
  });
});

test("case state transitions are explicit and fail closed", () => {
  assert.equal(nextSocialCaseState("pending", "acknowledge"), "acknowledged");
  assert.equal(nextSocialCaseState("acknowledged", "resolve"), "resolved");
  assert.equal(nextSocialCaseState("resolved", "reopen"), "pending");
  assert.throws(() => nextSocialCaseState("resolved", "resolve"), /invalid_social_case_transition/);
  assert.throws(() => nextSocialCaseState("pending", "reopen"), /invalid_social_case_transition/);
});
