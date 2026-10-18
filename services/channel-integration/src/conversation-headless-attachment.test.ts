import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fetchChatwootAttachment, ChatwootReadError } from "./conversation-headless-chatwoot.js";
import { MAX_ATTACHMENT_PROXY_BYTES } from "./conversation-headless-core.js";

test("attachment fetch follows only revalidated redirects and enforces size", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/file" });
      response.end();
      return;
    }
    if (request.url === "/large") {
      response.writeHead(200, { "content-length": String(MAX_ATTACHMENT_PROXY_BYTES + 1) });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "image/png" });
    response.end(Buffer.from("synthetic-image"));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const before = {
    internal: process.env.CHATWOOT_BASE_URL,
    publicUrl: process.env.CHATWOOT_PUBLIC_URL,
    allowed: process.env.CHATWOOT_ATTACHMENT_ALLOWED_ORIGINS
  };
  process.env.CHATWOOT_BASE_URL = base;
  process.env.CHATWOOT_PUBLIC_URL = "https://chat.example.test";
  delete process.env.CHATWOOT_ATTACHMENT_ALLOWED_ORIGINS;
  try {
    const result = await fetchChatwootAttachment(`${base}/redirect`);
    assert.equal(result.contentType, "image/png");
    assert.equal(result.bytes.toString(), "synthetic-image");
    await assert.rejects(() => fetchChatwootAttachment(`${base}/large`), (error: unknown) => {
      assert.ok(error instanceof ChatwootReadError);
      assert.equal(error.status, 413);
      return true;
    });
    await assert.rejects(() => fetchChatwootAttachment("https://evil.example/file"), (error: unknown) => {
      assert.ok(error instanceof ChatwootReadError);
      assert.equal(error.status, 403);
      return true;
    });
  } finally {
    server.close();
    if (before.internal === undefined) delete process.env.CHATWOOT_BASE_URL; else process.env.CHATWOOT_BASE_URL = before.internal;
    if (before.publicUrl === undefined) delete process.env.CHATWOOT_PUBLIC_URL; else process.env.CHATWOOT_PUBLIC_URL = before.publicUrl;
    if (before.allowed === undefined) delete process.env.CHATWOOT_ATTACHMENT_ALLOWED_ORIGINS; else process.env.CHATWOOT_ATTACHMENT_ALLOWED_ORIGINS = before.allowed;
  }
});
