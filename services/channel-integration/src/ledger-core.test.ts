import assert from "node:assert/strict";
import test from "node:test";
import { balanceDelta, ledgerRequestHash, reverseLedgerEntries, validateLedgerInput } from "./ledger-core.js";

const grant = { transaction_type: "gift_grant", currency: "cny", idempotency_key: "trial-001", source_type: "campaign", source_id: "welcome-v1", occurred_at: "2026-09-03T00:00:00+08:00", metadata: { campaign: "welcome", synthetic: true }, entries: [
  { account: "clearing", direction: "debit", amount_minor: 5000 },
  { account: "gift", direction: "credit", amount_minor: 5000, expires_at: "2026-10-03T00:00:00+08:00" },
] };

test("ledger accepts a balanced integer transaction and normalizes currency/time", () => {
  const value = validateLedgerInput(grant);
  assert.equal(value.currency, "CNY");
  assert.equal(value.entries.length, 2);
  assert.equal(value.occurred_at, "2026-09-02T16:00:00.000Z");
});

test("ledger rejects unbalanced, zero, floating and unsafe amounts", () => {
  for (const amount of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateLedgerInput({ ...grant, entries: [grant.entries[0], { ...grant.entries[1], amount_minor: amount }] }), /amount|balance/);
  assert.throws(() => validateLedgerInput({ ...grant, entries: [grant.entries[0], { ...grant.entries[1], amount_minor: 4999 }] }), /balance/);
});

test("cash cannot expire and reversal cannot be submitted as an ordinary transaction", () => {
  assert.throws(() => validateLedgerInput({ ...grant, entries: [grant.entries[0], { account: "cash", direction: "credit", amount_minor: 5000, expires_at: "2026-10-03T00:00:00Z" }] }), /expiry/);
  assert.throws(() => validateLedgerInput({ ...grant, transaction_type: "reversal" }), /type/);
});

test("request hash is stable across metadata key order and changes with facts", () => {
  const first = validateLedgerInput({ ...grant, metadata: { synthetic: true, campaign: "welcome" } });
  const second = validateLedgerInput({ ...grant, metadata: { campaign: "welcome", synthetic: true } });
  assert.equal(ledgerRequestHash(first), ledgerRequestHash(second));
  assert.notEqual(ledgerRequestHash(first), ledgerRequestHash(validateLedgerInput({ ...grant, source_id: "welcome-v2" })));
});

test("reversal swaps directions and clears grant expiry", () => {
  const reversed = reverseLedgerEntries(validateLedgerInput(grant).entries);
  assert.deepEqual(reversed.map(item => item.direction), ["credit", "debit"]);
  assert.equal(reversed[1].expires_at, null);
});

test("tenant balance accounts use credit-positive projection", () => {
  assert.equal(balanceDelta("gift", "credit", 5000), 5000);
  assert.equal(balanceDelta("gift", "debit", 1200), -1200);
  assert.equal(balanceDelta("revenue", "credit", 1200), 0);
});
