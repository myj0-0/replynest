export type ConversationAutomationSettingsInput = {
  reception_mode: 'manual' | 'draft' | 'automatic';
  automatic_sending_enabled: boolean;
  ai_auto_reply_enabled: boolean;
  ai_auto_send_confidence_threshold_percent: number;
  confirm_enable: boolean;
  reason: string;
};

export type ConversationAutomationValidation =
  | { ok: true; value: ConversationAutomationSettingsInput }
  | { ok: false; code: "invalid_automation_settings" | "enable_confirmation_required"; message: string };

const allowedKeys = new Set([
  "reception_mode",
  "automatic_sending_enabled",
  "ai_auto_reply_enabled",
  "ai_auto_send_confidence_threshold_percent",
  "confirm_enable",
  "reason"
]);

export function validateConversationAutomationSettings(input: unknown): ConversationAutomationValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "invalid_automation_settings", message: "自动化配置不合法" };
  }
  const record = {...input as Record<string, unknown>};
  if (record.reception_mode !== undefined) {
    if (!['manual','draft','automatic'].includes(String(record.reception_mode))) return {ok:false,code:'invalid_automation_settings',message:'请选择有效的接待模式'};
    const generate = record.reception_mode !== 'manual', send = record.reception_mode === 'automatic';
    if ((record.ai_auto_reply_enabled !== undefined && record.ai_auto_reply_enabled !== generate) || (record.automatic_sending_enabled !== undefined && record.automatic_sending_enabled !== send)) return {ok:false,code:'invalid_automation_settings',message:'接待模式与自动化开关不一致'};
    record.ai_auto_reply_enabled = generate;
    record.automatic_sending_enabled = send;
  }
  const threshold = record.ai_auto_send_confidence_threshold_percent;
  if (Object.keys(record).some(key => !allowedKeys.has(key)) ||
      typeof record.automatic_sending_enabled !== "boolean" ||
      typeof record.ai_auto_reply_enabled !== "boolean" ||
      !Number.isInteger(threshold) || Number(threshold) < 50 || Number(threshold) > 100) {
    return { ok: false, code: "invalid_automation_settings", message: "自动化开关或置信度阈值不合法；阈值必须是 50-100 的整数" };
  }
  const enabling = record.automatic_sending_enabled || record.ai_auto_reply_enabled;
  if (record.automatic_sending_enabled && !record.ai_auto_reply_enabled) {
    return { ok: false, code: 'invalid_automation_settings', message: 'AI 自动发送必须同时开启 AI 自动回复' };
  }
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  if (enabling && (record.confirm_enable !== true || reason.length < 8 || reason.length > 300)) {
    return { ok: false, code: "enable_confirmation_required", message: "开启自动化必须明确确认并填写 8-300 字原因" };
  }
  return {
    ok: true,
    value: {
      reception_mode: record.automatic_sending_enabled ? 'automatic' : record.ai_auto_reply_enabled ? 'draft' : 'manual',
      automatic_sending_enabled: record.automatic_sending_enabled,
      ai_auto_reply_enabled: record.ai_auto_reply_enabled,
      ai_auto_send_confidence_threshold_percent: Number(threshold),
      confirm_enable: record.confirm_enable === true,
      reason
    }
  };
}
