export function inboundRetryDelaySeconds(attempt: number, base = 5, maximum = 300): number {
  return Math.min(maximum, Math.max(1, base) * 2 ** Math.max(0, attempt - 1));
}

export function safeInboundFailure(error: unknown): { code: string; detail: string } {
  const message = error instanceof Error ? error.message : "unknown_error";
  if (/returned 4\d\d:/i.test(message) && !/returned 408:|returned 429:/i.test(message)) {
    return { code: "permanent_upstream_rejection", detail: "Upstream permanently rejected the inbound message" };
  }
  if (/invalid_|missing_/i.test(message)) return { code: "invalid_inbound_job", detail: "Stored inbound job is invalid" };
  return { code: "transient_processing_failure", detail: "Inbound processing failed and may be retried" };
}
