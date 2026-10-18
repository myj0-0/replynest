export type OutboundFailure = {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds: number | null;
};

const permanentWechatCodes = new Map<number, { code: string; message: string }>([
  [40003, { code: "invalid_recipient", message: "微信接收方标识无效" }],
  [45015, { code: "response_window_closed", message: "已超过微信客服消息可回复时限" }],
  [48001, { code: "api_unauthorized", message: "当前公众号没有客服消息接口权限" }]
]);

const retryableWechatCodes = new Map<number, { code: string; message: string; delay: number }>([
  [-1, { code: "wechat_system_busy", message: "微信系统繁忙", delay: 30 }],
  [40014, { code: "access_token_invalid", message: "微信 Access Token 无效", delay: 5 }],
  [42001, { code: "access_token_expired", message: "微信 Access Token 已过期", delay: 5 }],
  [45009, { code: "wechat_rate_limited", message: "微信接口调用达到频率限制", delay: 60 }]
]);

export function classifyOutboundFailure(error: unknown): OutboundFailure {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail === "wechat_live_send_disabled") {
    return { code: "live_send_disabled", message: "微信公众号真实发送开关未开启", retryable: false, retryAfterSeconds: null };
  }
  if (detail === "wechat_official_not_configured") {
    return { code: "channel_not_configured", message: "微信公众号发送参数未完整配置", retryable: false, retryAfterSeconds: null };
  }

  const providerError = detail.match(/^wechat_(?:send|token)_error:([\d-]+):(.*)$/s);
  if (providerError) {
    const providerCode = Number(providerError[1]);
    const permanent = permanentWechatCodes.get(providerCode);
    if (permanent) return { ...permanent, retryable: false, retryAfterSeconds: null };
    const retryable = retryableWechatCodes.get(providerCode);
    if (retryable) {
      return { code: retryable.code, message: retryable.message, retryable: true, retryAfterSeconds: retryable.delay };
    }
    return {
      code: `wechat_${providerCode}`,
      message: `微信接口拒绝请求（错误码 ${providerCode}）`,
      retryable: false,
      retryAfterSeconds: null
    };
  }

  if (/timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|network/i.test(detail)) {
    return { code: "transient_network_error", message: "网络异常，系统将自动重试", retryable: true, retryAfterSeconds: 30 };
  }
  return { code: "internal_delivery_error", message: "消息投递发生内部错误", retryable: false, retryAfterSeconds: null };
}

export function retryDelaySeconds(baseDelaySeconds: number, attemptCount: number): number {
  return Math.min(900, Math.max(5, baseDelaySeconds) * 2 ** Math.max(0, attemptCount - 1));
}

export function failureNote(messageId: string, failure: OutboundFailure, retryable: boolean): string {
  const action = retryable ? "系统将在稍后自动重试。" : "系统已停止自动重试，请在运营后台处理后人工重试。";
  return `⚠️ 消息发送失败（Chatwoot 消息 #${messageId}）\n原因：${failure.message}\n错误标识：${failure.code}\n${action}`;
}
