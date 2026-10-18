import { randomUUID } from "node:crypto";
import { mockSocialCapabilities, type SocialEventType, type SocialProvider } from "./social-channel-core.js";

export type MockSocialEventInput = {
  provider: SocialProvider;
  channel_connection_id: string;
  external_account_id: string;
  event_type: SocialEventType;
  content?: string;
  external_user_id?: string;
  video_id?: string;
  comment_id?: string;
  parent_comment_id?: string;
  occurred_at?: string;
};

export class MockSocialProvider {
  readonly networkCalls = 0;

  capabilities(provider: SocialProvider, now = new Date()) {
    return mockSocialCapabilities(provider, now);
  }

  event(input: MockSocialEventInput): Record<string, unknown> {
    const suffix = randomUUID();
    const isComment = input.event_type.startsWith("comment.");
    return {
      provider: input.provider,
      channel_connection_id: input.channel_connection_id,
      external_account_id: input.external_account_id,
      event_type: input.event_type,
      external_event_id: `mock-event-${suffix}`,
      external_user_id: input.external_user_id ?? `mock-user-${suffix}`,
      content: input.event_type === "auth.revoked" ? "" : input.content ?? "合成社交渠道消息",
      video_id: isComment ? input.video_id ?? `mock-video-${suffix}` : undefined,
      comment_id: isComment ? input.comment_id ?? `mock-comment-${suffix}` : undefined,
      parent_comment_id: input.parent_comment_id,
      occurred_at: input.occurred_at ?? new Date().toISOString(),
      metadata: { synthetic: true, provider_fixture: "mock-social-v1" },
    };
  }
}
