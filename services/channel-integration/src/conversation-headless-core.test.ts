import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentDisposition, canPerformConversationAction, decodeConversationCursor, encodeConversationCursor, isoTimestamp, normalizeMessageDirection,
  publicAttachment, resolveAttachmentFetchUrl, safeInlineAttachmentType, sanitizeAttachmentFileName
} from "./conversation-headless-core.js";

const secret = "phase-c3-synthetic-cursor-secret-at-least-32-characters";

test("headless cursor round trips and is bound to tenant and resource kind", () => {
  const cursor = encodeConversationCursor(secret, "tenant-a", "conversations", "3");
  assert.equal(decodeConversationCursor(cursor, secret, "tenant-a", "conversations"), "3");
  assert.equal(decodeConversationCursor(cursor, secret, "tenant-b", "conversations"), undefined);
  assert.equal(decodeConversationCursor(cursor, secret, "tenant-a", "messages"), undefined);
});

test("headless cursor rejects tampering", () => {
  const cursor = encodeConversationCursor(secret, "tenant-a", "messages", "108");
  assert.equal(decodeConversationCursor(`${cursor.slice(0, -1)}x`, secret, "tenant-a", "messages"), undefined);
});

test("attachment projection strips upstream URLs and identifiers", () => {
  const projected = publicAttachment("56df7d19-f0bd-48b8-a58e-a0d42cba35dc", {
    id: 9001,
    file_type: "image",
    file_name: "receipt.png",
    content_type: "image/png",
    file_size: 1024,
    data_url: "https://chatwoot.internal/secret",
    thumb_url: "https://chatwoot.internal/thumb"
  });
  assert.deepEqual(projected, {
    id: "56df7d19-f0bd-48b8-a58e-a0d42cba35dc",
    kind: "image",
    file_name: "receipt.png",
    content_type: "image/png",
    size_bytes: 1024,
    width: null,
    height: null,
    download_available: true,
    content_url: "/api/v1/attachments/56df7d19-f0bd-48b8-a58e-a0d42cba35dc/content",
    preview_url: "/api/v1/attachments/56df7d19-f0bd-48b8-a58e-a0d42cba35dc/content?disposition=inline"
  });
  assert.equal("data_url" in projected, false);
  assert.equal("thumb_url" in projected, false);
});

test("Chatwoot timestamps and message directions normalize into public values", () => {
  assert.equal(isoTimestamp(1_700_000_000), "2023-11-14T22:13:20.000Z");
  assert.equal(normalizeMessageDirection(0), "incoming");
  assert.equal(normalizeMessageDirection(1), "outgoing");
  assert.equal(normalizeMessageDirection(99), "unknown");
});

test("attachment proxy rewrites the public Chatwoot origin to its internal service", () => {
  const target = resolveAttachmentFetchUrl(
    "https://chat.replynest.cn/rails/active_storage/disk/signed-token/file.png",
    "http://rails:3000",
    "https://chat.replynest.cn"
  );
  assert.equal(target?.toString(), "http://rails:3000/rails/active_storage/disk/signed-token/file.png");
});

test("attachment proxy rejects unexpected and credential-bearing origins", () => {
  assert.equal(resolveAttachmentFetchUrl("https://evil.example/file", "http://rails:3000", "https://chat.replynest.cn"), undefined);
  assert.equal(resolveAttachmentFetchUrl("http://user:pass@rails:3000/file", "http://rails:3000", "https://chat.replynest.cn"), undefined);
  assert.equal(resolveAttachmentFetchUrl("https://objects.example/file", "http://rails:3000", "https://chat.replynest.cn", ["https://objects.example"] )?.origin, "https://objects.example");
});

test("attachment response policy sanitizes names and allows only passive inline types", () => {
  assert.equal(sanitizeAttachmentFileName("..\\订单\r\n.png", "fallback"), ".._订单__.png");
  assert.match(attachmentDisposition("订单.png", true), /^inline;/);
  assert.equal(safeInlineAttachmentType("image/png"), true);
  assert.equal(safeInlineAttachmentType("image/svg+xml"), false);
  assert.equal(safeInlineAttachmentType("text/html"), false);
});

test("conversation action policy permits self-claim and limits agent status changes to their own conversations", () => {
  assert.equal(canPerformConversationAction("agent", "agent-a", null, "claim"), true);
  assert.equal(canPerformConversationAction("agent", "agent-a", "agent-a", "claim"), true);
  assert.equal(canPerformConversationAction("agent", "agent-a", "agent-b", "claim"), false);
  assert.equal(canPerformConversationAction("agent", "agent-a", "agent-b", "assign"), false);
  assert.equal(canPerformConversationAction("supervisor", "supervisor-a", "agent-b", "assign"), true);
  assert.equal(canPerformConversationAction("tenant_admin", "admin-a", null, "assign"), true);
  assert.equal(canPerformConversationAction("agent", "agent-a", "agent-a", "set_status"), true);
  assert.equal(canPerformConversationAction("agent", "agent-a", null, "set_status"), false);
  assert.equal(canPerformConversationAction("agent", "agent-a", "agent-b", "set_status"), false);
  assert.equal(canPerformConversationAction("supervisor", "supervisor-a", "agent-b", "set_status"), true);
  assert.equal(canPerformConversationAction("tenant_admin", "admin-a", null, "set_status"), true);
});
