/** Only explicit provider rejection responses qualify. Network failures stay uncertain. */
export class WeChatSendRejected extends Error {
  constructor(public readonly providerCode: number) {
    super(`wechat_send_error:${providerCode}:rejected`);
  }
}
export function wechatRejectionState(code: number): "shared_window_expired" | "shared_rate_limited" | "shared_permission_denied" | "shared_rejected" {
  if (code === 45015) return "shared_window_expired";
  if ([45009, 45011, 45047].includes(code)) return "shared_rate_limited";
  if ([48001, 48002, 48004].includes(code)) return "shared_permission_denied";
  return "shared_rejected";
}
