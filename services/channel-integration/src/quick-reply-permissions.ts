/** Shared by every quick-reply mutation, including batch import. */
export function canManageQuickReplies(auth: { role: string; auth_kind: string; impersonation_id?: string | null; session_scope?: string | null }) {
  return auth.auth_kind === "console_session" && !auth.impersonation_id && auth.session_scope !== "copilot_embed" && ["tenant_admin", "supervisor"].includes(auth.role);
}
