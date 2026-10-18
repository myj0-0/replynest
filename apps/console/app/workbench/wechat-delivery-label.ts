export function wechatDeliveryFailure(state: string, en: boolean): string | undefined {
  const labels: Record<string, [string, string]> = {
    shared_window_expired: ["微信发送窗口已过期（45015），本条未发送。请客户重新发送消息，或改用网站客服。", "WeChat reply window expired (45015). Not sent. Ask the customer to message again or use website chat."],
    shared_rate_limited: ["微信消息额度或调用频率受限，本条未发送。请勿连续重试；共享公众号的额度可能受其他商家使用影响，可改用网站客服。", "WeChat message quota or rate limit reached. Not sent. Avoid repeated retries; shared-account usage may affect availability. Use website chat as a fallback."],
    shared_permission_denied: ["微信接口权限受限，本条未发送。请管理员检查公众号权限与用户接收条件。", "WeChat permission denied. Not sent. Ask an administrator to check account permissions and recipient eligibility."],
    shared_rejected: ["微信接口明确拒绝本条消息，未发送。请联系管理员核查，不要反复重发。", "WeChat rejected this message. Not sent. Contact an administrator before retrying."]
  };
  return labels[state]?.[en ? 1 : 0];
}
