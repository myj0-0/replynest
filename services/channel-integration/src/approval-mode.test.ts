import assert from "node:assert/strict";
import test from "node:test";
import { platformApprovalMode } from "./approval-mode.js";

test("platform approval defaults to dual when not explicitly configured", () => {
  const previous = process.env.PLATFORM_APPROVAL_MODE;
  delete process.env.PLATFORM_APPROVAL_MODE;
  assert.equal(platformApprovalMode(), "dual");
  if (previous === undefined) delete process.env.PLATFORM_APPROVAL_MODE; else process.env.PLATFORM_APPROVAL_MODE = previous;
});

test("platform approval supports explicit single administrator mode", () => {
  const previous = process.env.PLATFORM_APPROVAL_MODE;
  process.env.PLATFORM_APPROVAL_MODE = "single";
  assert.equal(platformApprovalMode(), "single");
  if (previous === undefined) delete process.env.PLATFORM_APPROVAL_MODE; else process.env.PLATFORM_APPROVAL_MODE = previous;
});
