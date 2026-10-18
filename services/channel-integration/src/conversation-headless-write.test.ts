import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { assignChatwootConversation, createChatwootOutgoingMessage, updateChatwootConversationStatus } from "./conversation-headless-chatwoot.js";

test("manual Chatwoot adapter sends only a public outgoing text message with a recovery marker", async () => {
  let received: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/v1/accounts/7/conversations/9/messages");
    assert.equal(request.headers.api_access_token, "test-token");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: 11, account_id: 7, conversation_id: 9, content: "人工回复", message_type: 1, status: "sent" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const previous = { base: process.env.CHATWOOT_BASE_URL, token: process.env.CHATWOOT_API_ACCESS_TOKEN };
  process.env.CHATWOOT_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.CHATWOOT_API_ACCESS_TOKEN = "test-token";
  try {
    const result = await createChatwootOutgoingMessage("7", "9", "人工回复", "00000000-0000-4000-8000-000000000001");
    assert.equal(result.id, 11);
    assert.deepEqual(received, {
      content: "人工回复", message_type: "outgoing", private: false, content_type: "text",
      content_attributes: { replynest_command_id: "00000000-0000-4000-8000-000000000001" }
    });
    await createChatwootOutgoingMessage("7", "9", "仅内部可见", "note-command", true);
    assert.deepEqual(received, {
      content: "仅内部可见", message_type: "outgoing", private: true, content_type: "text",
      content_attributes: { replynest_command_id: "note-command" }
    });
    await createChatwootOutgoingMessage("7", "9", "共享回复", "shared-command", false, true);
    assert.deepEqual(received, {
      content: "共享回复", message_type: "outgoing", private: false, content_type: "text",
      content_attributes: { replynest_command_id: "shared-command", replynest_transport: "shared_wechat" }
    });
  } finally {
    server.close();
    if (previous.base === undefined) delete process.env.CHATWOOT_BASE_URL; else process.env.CHATWOOT_BASE_URL = previous.base;
    if (previous.token === undefined) delete process.env.CHATWOOT_API_ACCESS_TOKEN; else process.env.CHATWOOT_API_ACCESS_TOKEN = previous.token;
  }
});

test("conversation action adapters send explicit desired state and self assignment", async () => {
  const received: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ url: request.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    assert.equal(request.method, "POST");
    assert.equal(request.headers.api_access_token, "test-token");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: 9, account_id: 7, status: "pending" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const previous = { base: process.env.CHATWOOT_BASE_URL, token: process.env.CHATWOOT_API_ACCESS_TOKEN };
  process.env.CHATWOOT_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.CHATWOOT_API_ACCESS_TOKEN = "test-token";
  try {
    await updateChatwootConversationStatus("7", "9", "pending");
    await assignChatwootConversation("7", "9", "13");
    assert.deepEqual(received, [
      { url: "/api/v1/accounts/7/conversations/9/toggle_status", body: { status: "pending", snoozed_until: null } },
      { url: "/api/v1/accounts/7/conversations/9/assignments", body: { assignee_id: 13, assignee_type: "User" } }
    ]);
  } finally {
    server.close();
    if (previous.base === undefined) delete process.env.CHATWOOT_BASE_URL; else process.env.CHATWOOT_BASE_URL = previous.base;
    if (previous.token === undefined) delete process.env.CHATWOOT_API_ACCESS_TOKEN; else process.env.CHATWOOT_API_ACCESS_TOKEN = previous.token;
  }
});
