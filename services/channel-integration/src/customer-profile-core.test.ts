import assert from "node:assert/strict";
import test from "node:test";
import { canEditCustomerProfile, validateCustomerProfile } from "./customer-profile-core.js";

const valid = { name: " Test customer ", email: "test@example.com", phone: "+86 123", note: "Team only", revision: "1234" };
test("customer profile validates and trims fields", () => {
  assert.equal(validateCustomerProfile(valid)?.name, "Test customer");
  assert.ok(validateCustomerProfile({ ...valid, email: "", phone: "", note: "" }));
});
test("customer profile rejects unsupported fields and malformed payloads", () => {
  for (const input of [null, [], {}, { ...valid, tenant_id: "another" }, { ...valid, name: " " }, { ...valid, note: "a".repeat(5001) }, { ...valid, phone: "a".repeat(65) }, { ...valid, email: "invalid" }, { ...valid, revision: "-1" }, { ...valid, revision: 1234 }]) assert.equal(validateCustomerProfile(input), null);
});
test("only managers and the assigned agent may edit", () => {
  assert.equal(canEditCustomerProfile("tenant_admin", "a", null), true);
  assert.equal(canEditCustomerProfile("supervisor", "a", "b"), true);
  assert.equal(canEditCustomerProfile("agent", "a", "a"), true);
  assert.equal(canEditCustomerProfile("agent", "a", "b"), false);
  assert.equal(canEditCustomerProfile("agent", "a", null), false);
  assert.equal(canEditCustomerProfile("unknown", "a", "a"), false);
});
