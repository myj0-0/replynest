export type DashboardContextInput = {
  conversation_id?: unknown;
  account_id?: unknown;
  current_agent_email?: unknown;
};

export function validateDashboardContextInput(input: DashboardContextInput) {
  const conversationId = String(input.conversation_id ?? "");
  const accountId = String(input.account_id ?? "");
  const agentEmail = String(input.current_agent_email ?? "").trim().toLowerCase();
  if (!/^\d+$/.test(conversationId)) return { error: "invalid_conversation_id" as const };
  if (!/^\d+$/.test(accountId)) return { error: "invalid_account_id" as const };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(agentEmail) || agentEmail.length > 320) return { error: "invalid_agent_email" as const };
  return { conversationId, accountId, agentEmail };
}
