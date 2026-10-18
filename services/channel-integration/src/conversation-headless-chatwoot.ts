import { requiredEnv } from "./shared.js";
import { MAX_ATTACHMENT_PROXY_BYTES, resolveAttachmentFetchUrl } from "./conversation-headless-core.js";

export type ChatwootRecord = Record<string, unknown>;

export class ChatwootReadError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export class ChatwootWriteError extends Error {
  constructor(public readonly status: number, public readonly uncertain: boolean, message: string) {
    super(message);
  }
}

function config() {
  return {
    baseUrl: requiredEnv("CHATWOOT_BASE_URL").replace(/\/$/, ""),
    token: requiredEnv("CHATWOOT_API_ACCESS_TOKEN")
  };
}

async function getJson(path: string): Promise<unknown> {
  const { baseUrl, token } = config();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { api_access_token: token, "x-forwarded-proto": "https", accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
  const text = await response.text();
  if (!response.ok) throw new ChatwootReadError(response.status, `Chatwoot read returned ${response.status}: ${text.slice(0, 200)}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ChatwootReadError(502, "Chatwoot returned invalid JSON");
  }
}

function numericId(value: number | string, name: string): string {
  const normalized = String(value);
  if (!/^\d+$/.test(normalized)) throw new Error(`${name} must be numeric`);
  return normalized;
}

async function postJson(path: string, body: Record<string, unknown>): Promise<ChatwootRecord> {
  const { baseUrl, token } = config();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        api_access_token: token,
        "content-type": "application/json",
        accept: "application/json",
        "x-forwarded-proto": "https"
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
  } catch (error) {
    throw new ChatwootWriteError(503, true, `Chatwoot write outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new ChatwootWriteError(response.status, response.status >= 500, `Chatwoot write returned ${response.status}: ${text.slice(0, 200)}`);
  }
  try {
    const parsed = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object") throw new Error("invalid response object");
    return parsed as ChatwootRecord;
  } catch {
    throw new ChatwootWriteError(502, true, "Chatwoot accepted the request but returned invalid JSON");
  }
}

export async function updateChatwootConversationStatus(
  accountId: string,
  conversationId: string,
  status: "open" | "pending" | "resolved"
): Promise<ChatwootRecord> {
  const account = numericId(accountId, "account id");
  const conversation = numericId(conversationId, "conversation id");
  return postJson(`/api/v1/accounts/${account}/conversations/${conversation}/toggle_status`, {
    status,
    snoozed_until: null
  });
}

export async function assignChatwootConversation(
  accountId: string,
  conversationId: string,
  agentId: string
): Promise<ChatwootRecord> {
  const account = numericId(accountId, "account id");
  const conversation = numericId(conversationId, "conversation id");
  const assignee = Number(numericId(agentId, "agent id"));
  return postJson(`/api/v1/accounts/${account}/conversations/${conversation}/assignments`, {
    assignee_id: assignee,
    assignee_type: "User"
  });
}

export async function createChatwootOutgoingMessage(
  accountId: string,
  conversationId: string,
  content: string,
  commandId: string,
  isPrivate = false,
  sharedWechat: boolean|'wechat_media_manual' = false
): Promise<ChatwootRecord> {
  const account = numericId(accountId, "account id");
  const conversation = numericId(conversationId, "conversation id");
  const { baseUrl, token } = config();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/v1/accounts/${account}/conversations/${conversation}/messages`, {
      method: "POST",
      headers: {
        api_access_token: token,
        "content-type": "application/json",
        accept: "application/json",
        "x-forwarded-proto": "https"
      },
      body: JSON.stringify({
        content,
        message_type: "outgoing",
        private: isPrivate,
        content_type: "text",
        content_attributes: { replynest_command_id: commandId, ...(sharedWechat ? { replynest_transport: sharedWechat===true?"shared_wechat":sharedWechat } : {}) }
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
  } catch (error) {
    throw new ChatwootWriteError(503, true, `Chatwoot write outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new ChatwootWriteError(response.status, response.status >= 500, `Chatwoot write returned ${response.status}: ${text.slice(0, 200)}`);
  }
  try {
    const parsed = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object") throw new Error("invalid response object");
    return parsed as ChatwootRecord;
  } catch {
    throw new ChatwootWriteError(502, true, "Chatwoot accepted the request but returned invalid JSON");
  }
}

export async function getChatwootInbox(accountId:string,inboxId:string):Promise<ChatwootRecord>{
  return await getJson(`/api/v1/accounts/${numericId(accountId,'account id')}/inboxes/${numericId(inboxId,'inbox id')}`) as ChatwootRecord;
}

export async function listChatwootConversations(accountId: string, page: number, status: string, content?: string): Promise<ChatwootRecord[]> {
  const account = numericId(accountId, "account id");
  if (!Number.isInteger(page) || page < 1 || page > 100_000) throw new Error("page is invalid");
  const allowedStatus = new Set(["all", "open", "pending", "resolved", "snoozed"]);
  if (!allowedStatus.has(status)) throw new Error("status is invalid");
  const payload = await getJson(`/api/v1/accounts/${account}/conversations?status=${status}&page=${page}${content ? `&q=${encodeURIComponent(content)}` : ''}`) as ChatwootRecord;
  const data = payload.data as ChatwootRecord | undefined;
  return Array.isArray(data?.payload) ? data.payload.filter((item): item is ChatwootRecord => Boolean(item) && typeof item === "object") : [];
}

export async function getChatwootConversation(accountId: string, conversationId: string): Promise<ChatwootRecord> {
  const account = numericId(accountId, "account id");
  const conversation = numericId(conversationId, "conversation id");
  const value = await getJson(`/api/v1/accounts/${account}/conversations/${conversation}`);
  if (!value || typeof value !== "object") throw new ChatwootReadError(502, "Chatwoot returned an invalid conversation");
  return value as ChatwootRecord;
}

export async function listChatwootMessages(accountId: string, conversationId: string, before?: string): Promise<ChatwootRecord[]> {
  const account = numericId(accountId, "account id");
  const conversation = numericId(conversationId, "conversation id");
  const query = before ? `?before=${numericId(before, "message cursor")}` : "";
  const value = await getJson(`/api/v1/accounts/${account}/conversations/${conversation}/messages${query}`) as ChatwootRecord;
  return Array.isArray(value.payload) ? value.payload.filter((item): item is ChatwootRecord => Boolean(item) && typeof item === "object") : [];
}

export async function findChatwootMessage(accountId: string, conversationId: string, messageId: string): Promise<ChatwootRecord | undefined> {
  const account = numericId(accountId, "account id");
  const conversation = numericId(conversationId, "conversation id");
  const message = numericId(messageId, "message id");
  const after = BigInt(message) > 0n ? String(BigInt(message) - 1n) : "0";
  const value = await getJson(`/api/v1/accounts/${account}/conversations/${conversation}/messages?after=${after}`) as ChatwootRecord;
  const messages = Array.isArray(value.payload) ? value.payload.filter((item): item is ChatwootRecord => Boolean(item) && typeof item === "object") : [];
  return messages.find(item => String(item.id ?? "") === message);
}

export type AttachmentBytes = { bytes: Buffer; contentType: string; contentLength: number };

function attachmentAllowedOrigins(): string[] {
  return (process.env.CHATWOOT_ATTACHMENT_ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
}

export async function fetchChatwootAttachment(rawUrl: string): Promise<AttachmentBytes> {
  const internalBaseUrl = requiredEnv("CHATWOOT_BASE_URL");
  const publicBaseUrl = requiredEnv("CHATWOOT_PUBLIC_URL");
  let target = resolveAttachmentFetchUrl(rawUrl, internalBaseUrl, publicBaseUrl, attachmentAllowedOrigins());
  if (!target) throw new ChatwootReadError(403, "Attachment source is not allowlisted");
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response: Response = await fetch(target, {
      headers: { "x-forwarded-proto": "https", accept: "*/*" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000)
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location: string | null = response.headers.get("location");
      target = location ? resolveAttachmentFetchUrl(new URL(location, target).toString(), internalBaseUrl, publicBaseUrl, attachmentAllowedOrigins()) : undefined;
      if (!target) throw new ChatwootReadError(403, "Attachment redirect is not allowlisted");
      continue;
    }
    if (!response.ok) throw new ChatwootReadError(response.status, `Attachment source returned ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_PROXY_BYTES) throw new ChatwootReadError(413, "Attachment exceeds proxy limit");
    if (!response.body) throw new ChatwootReadError(502, "Attachment source returned an empty body");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ATTACHMENT_PROXY_BYTES) {
        await reader.cancel();
        throw new ChatwootReadError(413, "Attachment exceeds proxy limit");
      }
      chunks.push(Buffer.from(value));
    }
    return {
      bytes: Buffer.concat(chunks, size),
      contentType: response.headers.get("content-type")?.slice(0, 200) || "application/octet-stream",
      contentLength: size
    };
  }
  throw new ChatwootReadError(502, "Attachment source exceeded redirect limit");
}
