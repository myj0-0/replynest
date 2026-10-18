import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeHeader } from "./smtp-mailer.js";

test("mail subjects and addresses cannot inject SMTP headers", () => {
  assert.equal(sanitizeHeader("邀请\r\nBcc: attacker@example.test"), "邀请 Bcc: attacker@example.test");
});
