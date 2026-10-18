// Only known public error codes may cross the server redirect boundary.
const messages: Record<string, [string, string]> = {
  entitlement_limit_reached: ["坐席名额已满（待接受邀请也占用名额）。请撤销不需要的邀请、禁用不再使用的成员，或升级套餐后重试。", "All seats are reserved, including pending invitations. Revoke an unused invitation, disable an unused member, or upgrade your plan."],
  member_exists: ["该邮箱已是本企业成员，无需重复邀请。", "This email already belongs to a member of this workspace."],
  invalid_invitation: ["请填写有效的邮箱、成员姓名和角色。支持 QQ、163 等不同域名的邮箱。", "Enter a valid email, member name and role. Different email domains are supported."],
  invitation_delivery_failed: ["邀请邮件发送失败，名额未被保留。请稍后重试。", "The invitation email could not be sent. No seat was reserved. Try again later."],
  invitation_not_pending: ["该邀请已被接受或撤销，请刷新成员列表。", "This invitation has already been accepted or revoked. Refresh the member list."],
  forbidden: ["只有企业管理员可以管理成员及邀请。", "Only workspace administrators can manage members and invitations."],
  cannot_modify_self: ["不能在此修改或禁用当前管理员账号。", "You cannot modify or disable your own administrator account here."],
  invalid_member_update: ["成员设置无效，请核对角色和状态。", "Check the member role and status."],
  member_not_found: ["未找到该成员，请刷新成员列表。", "Member not found. Refresh the member list."],
  chatwoot_member_sync_failed: ["成员同步暂未完成，请稍后点击重试同步。", "Member synchronization is incomplete. Retry synchronization later."],
};

export function memberErrorMessage(code: string, en: boolean): string {
  return messages[code]?.[en ? 1 : 0] ?? (en ? "Operation failed. Refresh the page and try again." : "操作未完成，请刷新页面后重试。");
}

export async function memberErrorCode(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { code?: unknown } };
    const code = body.error?.code;
    if (typeof code === "string" && Object.hasOwn(messages, code)) return code;
  } catch { /* Never echo an upstream response or arbitrary URL text. */ }
  return "operation_failed";
}
