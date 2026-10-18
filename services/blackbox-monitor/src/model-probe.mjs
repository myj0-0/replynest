// Fetches only cached probe results: public status polling never invokes a model.
export function modelProbeResult(value, now = Date.now()) {
  const checked = Date.parse(value?.checked_at);
  const fresh = Number.isFinite(checked) && checked <= now + 60_000 && now - checked <= 600_000;
  return {
    ok: fresh && value?.status === 'operational',
    latency_ms: Number.isFinite(value?.latency_ms) ? Math.max(0, value.latency_ms) : 0,
    model_checked_at: fresh ? value.checked_at : null,
    error: fresh ? (value?.status === 'operational' ? undefined : 'model_unavailable') : 'model_probe_stale'
  };
}
