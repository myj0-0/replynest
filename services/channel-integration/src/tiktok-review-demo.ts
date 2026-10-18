import { MockSocialProvider } from "./mock-social-provider.js";

export const tiktokReviewEventTypes = ["dm.message", "comment.created"] as const;
export type TikTokReviewEventType = typeof tiktokReviewEventTypes[number];

export const tiktokReviewSamples: Record<TikTokReviewEventType, string[]> = {
  "dm.message": [
    "Hi, I need help choosing the right plan for three TikTok accounts.",
    "My order arrived damaged. How can I request a replacement?",
  ],
  "comment.created": [
    "Can I buy this in bulk? Please send me the purchase details.",
    "My order arrived damaged. How can I request a replacement?",
    "I will report this if nobody handles my refund.",
  ],
};

export function validateTikTokReviewEvent(input: Record<string, unknown>): { event_type: TikTokReviewEventType; content: string } {
  const eventType = String(input.event_type ?? "") as TikTokReviewEventType;
  if (!tiktokReviewEventTypes.includes(eventType)) throw new Error("invalid_review_demo_event_type");
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!content || content.length > 1_000) throw new Error("invalid_review_demo_content");
  return { event_type: eventType, content };
}

export function tiktokReviewPrototypeDisclosure() {
  return {
    prototype: true,
    synthetic_data: true,
    network_calls: 0,
    provider_writes: 0,
    live_authorization: false,
    automatic_send: false,
    description: "Review prototype only. No TikTok account, user or network request is involved.",
  } as const;
}

export function createTikTokReviewMockEvent(input: {
  channel_connection_id: string;
  external_account_id: string;
  event_type: TikTokReviewEventType;
  content: string;
}) {
  const mock = new MockSocialProvider();
  return {
    event: mock.event({
      provider: "tiktok",
      channel_connection_id: input.channel_connection_id,
      external_account_id: input.external_account_id,
      event_type: input.event_type,
      content: input.content,
    }),
    capabilities: mock.capabilities("tiktok"),
    disclosure: tiktokReviewPrototypeDisclosure(),
  };
}
