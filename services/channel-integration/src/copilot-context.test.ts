import assert from "node:assert/strict";
import test from "node:test";
import { validateDashboardContextInput } from "./copilot-context.js";

test("dashboard context accepts numeric ids and normalizes agent email", () => {
  assert.deepEqual(validateDashboardContextInput({ conversation_id: 42, account_id: "7", current_agent_email: " Agent@Example.COM " }), {
    conversationId: "42", accountId: "7", agentEmail: "agent@example.com"
  });
});

test("dashboard context rejects forged or incomplete identifiers", () => {
  assert.deepEqual(validateDashboardContextInput({ conversation_id: "1 OR 1=1", account_id: 7, current_agent_email: "a@example.com" }), { error: "invalid_conversation_id" });
  assert.deepEqual(validateDashboardContextInput({ conversation_id: 1, account_id: 7, current_agent_email: "not-an-email" }), { error: "invalid_agent_email" });
});
