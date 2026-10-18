import { postJson, requiredEnv } from "./shared.js";

const baseUrl = requiredEnv("CHATWOOT_BASE_URL");
const inboxIdentifier = requiredEnv("CHATWOOT_INBOX_IDENTIFIER");
const inboxBase = `${baseUrl}/public/api/v1/inboxes/${inboxIdentifier}`;

type ContactResponse = { source_id: string; contact?: { id?: number } };
type ConversationResponse = { id: number };
type MessageResponse = { id: number };

export async function createContact(externalUserId: string, name: string, sourceChannel = "mock-wechat"): Promise<ContactResponse> {
  return postJson(`${inboxBase}/contacts`, {
    identifier: externalUserId,
    name,
    custom_attributes: { source_channel: sourceChannel }
  }, { "x-forwarded-proto": "https" }) as Promise<ContactResponse>;
}

export async function createConversation(sourceId: string, sourceChannel = "mock-wechat"): Promise<ConversationResponse> {
  return postJson(`${inboxBase}/contacts/${encodeURIComponent(sourceId)}/conversations`, {
    custom_attributes: { source_channel: sourceChannel }
  }, { "x-forwarded-proto": "https" }) as Promise<ConversationResponse>;
}

export async function createIncomingMessage(sourceId: string, conversationId: string, content: string, echoId: string): Promise<MessageResponse> {
  return postJson(
    `${inboxBase}/contacts/${encodeURIComponent(sourceId)}/conversations/${conversationId}/messages`,
    { content, echo_id: echoId },
    { "x-forwarded-proto": "https" }
  ) as Promise<MessageResponse>;
}
