const drillIdPattern = /^[A-Za-z0-9_-]{1,64}$/;

export function parseFaultInjection(raw, targetIds, now = Date.now(), maxDurationMs = 15 * 60_000) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  const expiresAt = Date.parse(value?.expires_at);
  if (
    value?.schema_version !== 1 ||
    !targetIds.has(value?.target_id) ||
    !drillIdPattern.test(value?.drill_id ?? "") ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + maxDurationMs
  ) {
    return null;
  }

  return {
    target_id: value.target_id,
    drill_id: value.drill_id,
    expires_at: new Date(expiresAt).toISOString()
  };
}

export function shouldSendFailureAlert(status, lastAlertAt, now, cooldownMs) {
  return status !== "down" || now - lastAlertAt >= cooldownMs;
}
