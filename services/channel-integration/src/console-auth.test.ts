import assert from "node:assert/strict";
import test from "node:test";
import { hashConsolePassword, verifyConsolePassword } from "./console-password.js";

test("console passwords use salted scrypt hashes", async () => {
  const first = await hashConsolePassword("correct-horse-battery-staple");
  const second = await hashConsolePassword("correct-horse-battery-staple");
  assert.notEqual(first, second);
  assert.equal(await verifyConsolePassword("correct-horse-battery-staple", first), true);
  assert.equal(await verifyConsolePassword("wrong-password-value", first), false);
});

test("console password policy rejects short secrets", async () => {
  await assert.rejects(() => hashConsolePassword("too-short"), /12-128/);
});
