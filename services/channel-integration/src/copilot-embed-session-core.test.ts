import assert from "node:assert/strict";
import test from "node:test";
import { copilotEmbedRouteAllowed } from "./copilot-embed-session-core.js";

test("Copilot embed session is limited to recommendation context, creation and action", () => {
  assert.equal(copilotEmbedRouteAllowed("POST", "/api/v1/copilot/context"), true);
  assert.equal(copilotEmbedRouteAllowed("POST", "/api/v1/ai/recommendations"), true);
  assert.equal(copilotEmbedRouteAllowed("POST", "/api/v1/ai/recommendations/0199c8b1-3e36-7a45-9c1a-0ee6f1b7be55/actions"), true);
});

test("Copilot embed session cannot access tenant administration or read APIs", () => {
  assert.equal(copilotEmbedRouteAllowed("GET", "/api/v1/ai/recommendations"), false);
  assert.equal(copilotEmbedRouteAllowed("POST", "/api/v1/session/chatwoot-link"), false);
  assert.equal(copilotEmbedRouteAllowed("POST", "/api/v1/billing/payment-orders"), false);
  assert.equal(copilotEmbedRouteAllowed("POST", "/api/v1/ai/recommendations/not-a-uuid/actions"), false);
});
