import { createHmac, timingSafeEqual } from "node:crypto";

export type ConversationCursorKind = "conversations" | "messages" | `search:${string}`;

type CursorPayload = {
  v: 1;
  tenant_id: string;
  kind: ConversationCursorKind;
  position: string;
};

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function encodeConversationCursor(
  secret: string,
  tenantId: string,
  kind: ConversationCursorKind,
  position: string
): string {
  if (secret.length < 32) throw new Error("cursor secret must contain at least 32 characters");
  const body = base64url(JSON.stringify({ v: 1, tenant_id: tenantId, kind, position } satisfies CursorPayload));
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function decodeConversationCursor(
  cursor: string,
  secret: string,
  tenantId: string,
  kind: ConversationCursorKind
): string | undefined {
  if (!cursor || cursor.length > 1024 || secret.length < 32) return undefined;
  const parts = cursor.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  const expected = createHmac("sha256", secret).update(parts[0]).digest();
  let received: Buffer;
  try {
    received = Buffer.from(parts[1], "base64url");
  } catch {
    return undefined;
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (payload.v !== 1 || payload.tenant_id !== tenantId || payload.kind !== kind) return undefined;
    return typeof payload.position === "string" && payload.position.length <= 128 ? payload.position : undefined;
  } catch {
    return undefined;
  }
}

export function isoTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : /^\d+(?:\.\d+)?$/.test(String(value)) ? Number(value) : NaN;
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeConversationStatus(value: unknown): "open" | "pending" | "resolved" | "snoozed" | "unknown" {
  return value === "open" || value === "pending" || value === "resolved" || value === "snoozed" ? value : "unknown";
}

export type ConversationAction = "claim" | "assign" | "set_status";
export type ConversationActionRole = "tenant_admin" | "supervisor" | "agent";

export function canPerformConversationAction(
  role: ConversationActionRole,
  actorId: string,
  assigneeId: string | null,
  action: ConversationAction
): boolean {
  if (action === "claim") return assigneeId === null || assigneeId === actorId;
  if (action === "assign") return role === "tenant_admin" || role === "supervisor";
  return role === "tenant_admin" || role === "supervisor" || assigneeId === actorId;
}

export function normalizeMessageDirection(value: unknown): "incoming" | "outgoing" | "activity" | "template" | "unknown" {
  if (value === 0 || value === "incoming") return "incoming";
  if (value === 1 || value === "outgoing") return "outgoing";
  if (value === 2 || value === "activity") return "activity";
  if (value === 3 || value === "template") return "template";
  return "unknown";
}

export type PublicAttachment = {
  id: string;
  kind: string;
  file_name: string | null;
  content_type: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  download_available: boolean;
  processing_status?:string;
  content_url: string;
  preview_url: string;
};

export function publicAttachment(replynestId: string, raw: Record<string, unknown>): PublicAttachment {
  const size = Number(raw.file_size);
  const width = Number(raw.width);
  const height = Number(raw.height);
  return {
    id: replynestId,
    kind: typeof raw.file_type === "string" ? raw.file_type : "file",
    file_name: typeof raw.file_name === "string" ? raw.file_name : null,
    content_type: typeof raw.content_type === "string" ? raw.content_type : null,
    size_bytes: Number.isFinite(size) && size >= 0 ? size : null,
    width: Number.isFinite(width) && width >= 0 ? width : null,
    height: Number.isFinite(height) && height >= 0 ? height : null,
    download_available: true,
    content_url: `/api/v1/attachments/${replynestId}/content`,
    preview_url: `/api/v1/attachments/${replynestId}/content?disposition=inline`
  };
}

export function safeText(value: unknown, maximum = 20_000): string | null {
  return typeof value === "string" ? value.slice(0, maximum) : null;
}

export const MAX_ATTACHMENT_PROXY_BYTES = 25 * 1024 * 1024;

export function sanitizeAttachmentFileName(value: unknown, fallback: string): string {
  const source = typeof value === "string" ? value : fallback;
  const normalized = source.normalize("NFKC").replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_").trim();
  return (normalized || fallback).slice(0, 180);
}

export function attachmentDisposition(fileName: string, inline: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function safeInlineAttachmentType(contentType: string): boolean {
  return new Set([
    "image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf", "text/plain", "video/mp4", "audio/mpeg", "audio/ogg"
  ]).has(contentType.toLowerCase().split(";", 1)[0].trim());
}

export function resolveAttachmentFetchUrl(
  rawUrl: string,
  internalBaseUrl: string,
  publicBaseUrl: string,
  additionalAllowedOrigins: string[] = []
): URL | undefined {
  let internal: URL;
  let publicUrl: URL;
  let candidate: URL;
  try {
    internal = new URL(internalBaseUrl);
    publicUrl = new URL(publicBaseUrl);
    candidate = new URL(rawUrl, publicUrl);
  } catch {
    return undefined;
  }
  if (!["http:", "https:"].includes(candidate.protocol) || candidate.username || candidate.password) return undefined;
  if (candidate.origin === publicUrl.origin) {
    candidate = new URL(`${candidate.pathname}${candidate.search}`, internal);
  }
  const allowed = new Set([internal.origin, ...additionalAllowedOrigins.flatMap(value => {
    try { return [new URL(value).origin]; } catch { return []; }
  })]);
  return allowed.has(candidate.origin) ? candidate : undefined;
}
