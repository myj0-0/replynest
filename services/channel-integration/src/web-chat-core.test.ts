import assert from "node:assert/strict";
import test from "node:test";
import { webChatInput, websiteOrigin, widgetLoader } from "./web-chat-core.js";
test("website configuration requires an HTTPS public origin and bounded fields", () => {
  assert.equal(websiteOrigin("https://www.example.com/path?q=x"), "https://www.example.com");
  for (const value of ["http://example.com", "javascript:alert(1)", "https://user:pass@example.com", "https://localhost", null]) assert.equal(websiteOrigin(value), null);
  assert.deepEqual(webChatInput({ display_name: " Support ", website_url: "https://example.com" }), { display_name: "Support", website_url: "https://example.com" });
  assert.equal(webChatInput({ display_name: "", website_url: "https://example.com" }), null);
  assert.equal(webChatInput({ display_name: "Support", website_url: "https://example.com", tenant_id: "other" }), null);
});
test("widget uses only public configuration and escapes script delimiters", () => {
  const script = widgetLoader("https://support.example.com/path", "</script>test");
  assert.ok(!script.includes("</script>"));
  assert.ok(script.includes("https://support.example.com"));
  assert.ok(!script.includes("api_access_token"));
  assert.ok(!script.includes("setUser"));
  assert.doesNotThrow(() => new Function(script));
});
