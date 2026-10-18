export function normalizeReplyText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

export function classifyDeliveredRecommendation(originalText: string, finalText: string): "accepted" | "edited" {
  return normalizeReplyText(originalText) === normalizeReplyText(finalText) ? "accepted" : "edited";
}
