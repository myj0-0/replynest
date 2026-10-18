import assert from "node:assert/strict";
import test from "node:test";
import { signature, verifySignature } from "./shared.js";

test("valid signatures are accepted", () => {
  const body = Buffer.from('{"hello":"world"}');
  const timestamp = String(Date.now());
  const value = signature("secret", timestamp, "nonce", body);
  assert.equal(verifySignature("secret", timestamp, "nonce", body, value), true);
});

test("tampered and expired requests are rejected", () => {
  const body = Buffer.from("original");
  const timestamp = String(Date.now());
  const value = signature("secret", timestamp, "nonce", body);
  assert.equal(verifySignature("secret", timestamp, "nonce", Buffer.from("changed"), value), false);
  const old = String(Date.now() - 6 * 60_000);
  assert.equal(verifySignature("secret", old, "nonce", body, signature("secret", old, "nonce", body)), false);
});
