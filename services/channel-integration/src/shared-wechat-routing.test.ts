import test from "node:test";
import assert from "node:assert/strict";
import { extractSharedScene, routeSharedEvent, sceneDigest, sceneToken, type RoutingState, type RoutingEvent, type Scene } from "./shared-wechat-routing.js";
const now = 1_800_000_000_000;
const active = new Set(["merchant-a", "merchant-b"]);
const initial = (): RoutingState => ({ appId: "app", openId: "user", associations: [], lastTransitionAt: 0, version: 0 });
const scene = (tenantId: string): Scene => ({ appId: "app", tenantId, name: tenantId, expiresAt: now + 999_000, revoked: false });
const scan = (tenantId: string, time = now): RoutingEvent => ({ appId: "app", openId: "user", eventId: `scan-${time}`, occurredAt: time, kind: "scan", scene: scene(tenantId) });
const text = (value: string, time = now + 3000): RoutingEvent => ({ appId: "app", openId: "user", eventId: `text-${time}`, occurredAt: time, kind: "text", text: value });
test("single association routes without choosing", () => {
  const result = routeSharedEvent(initial(), scan("merchant-a"), active, now);
  assert.equal(result.action, "entered");
  assert.equal(routeSharedEvent(result.state, text("hello"), active, now + 3000).tenantId, "merchant-a");
  assert.deepEqual(initial().associations, []);
});
test("second scan clears old destination and requires an explicit opaque choice", () => {
  const first = routeSharedEvent(initial(), scan("merchant-a"), active, now);
  const second = routeSharedEvent(first.state, scan("merchant-b", now + 1000), active, now + 1000, () => "test-code");
  assert.equal(second.action, "choose"); assert.equal(second.tenantId, undefined); assert.equal(second.state.selected, undefined);
  assert.equal(routeSharedEvent(second.state, text("hello"), active, now + 3000).action, "choose");
});
test("choice is scoped to identity, consumed once, and pins later text", () => {
  const state = initial(); state.associations = [{ tenantId: "merchant-a", name: "A" }, { tenantId: "merchant-b", name: "B" }];
  let n = 0;
  const prompt = routeSharedEvent(state, text("hi"), active, now + 3000, () => `code-${++n}`);
  const selected = routeSharedEvent(prompt.state, text("选择 code-2", now + 4000), active, now + 4000);
  assert.equal(selected.tenantId, "merchant-b"); assert.equal(selected.action, "entered");
  assert.equal(routeSharedEvent(selected.state, text("hello", now + 5000), active, now + 5000).tenantId, "merchant-b");
  assert.equal(routeSharedEvent(selected.state, text("选择 code-2", now + 5000), active, now + 5000).reason, "invalid_choice");
  assert.throws(() => routeSharedEvent(state, { ...text("hi"), openId: "other" }, active, now + 3000), /identity_mismatch/);
  assert.throws(() => routeSharedEvent(state, { ...text("hi"), appId: "other" }, active, now + 3000), /identity_mismatch/);
});
test("expired, revoked, foreign-account and inactive scenes never associate", () => {
  for (const override of [{ expiresAt: now }, { revoked: true }, { appId: "foreign" }, { tenantId: "disabled" }]) {
    const result = routeSharedEvent(initial(), { ...scan("merchant-a"), kind: "scan", scene: { ...scene("merchant-a"), ...override } }, active, now);
    assert.equal(result.action, "ignore"); assert.equal(result.state.associations.length, 0);
  }
});
test("stale scan cannot override new selection; transition replay is ignored", () => {
  const first = routeSharedEvent(initial(), scan("merchant-a"), active, now);
  assert.equal(routeSharedEvent(first.state, scan("merchant-b", now - 1000), active, now).reason, "stale_event");
  assert.equal(routeSharedEvent(first.state, scan("merchant-a"), active, now).reason, "stale_event");
});
test("expired selection prompts; no active associations never route; unsubscribe clears all", () => {
  const state = initial(); state.associations = [{ tenantId: "merchant-a", name: "A" }, { tenantId: "merchant-b", name: "B" }];
  state.selected = { tenantId: "merchant-a", expiresAt: now };
  assert.equal(routeSharedEvent(state, text("hello"), active, now + 3000).action, "choose");
  assert.equal(routeSharedEvent(state, text("hello"), new Set(), now + 3000).reason, "no_active_association");
  const result = routeSharedEvent(state, { ...text(""), kind: "unsubscribe" }, active, now + 3000);
  assert.equal(result.action, "unlinked"); assert.deepEqual(result.state.associations, []);
});
test("scene is opaque and supports subscribe/SCAN only", () => {
  const token = sceneToken(); assert.equal(token.digest, sceneDigest(token.value));
  assert.equal(extractSharedScene("subscribe", `qrscene_${token.value}`), token.value);
  assert.equal(extractSharedScene("SCAN", token.value), token.value);
  assert.equal(extractSharedScene("CLICK", token.value), null);
  assert.equal(extractSharedScene("SCAN", "merchant-a"), null);
});

test("bare active codes select a merchant; unrelated replies preserve the current menu", () => {
  const state = initial(); state.associations = [{ tenantId: "merchant-a", name: "A" }, { tenantId: "merchant-b", name: "B" }];
  let n=0;
  const prompt=routeSharedEvent(state,text("hi"),active,now+3000,()=>`opaque-${++n}`);
  const repeated=routeSharedEvent(prompt.state,text("how do I choose?",now+4000),active,now+4000);
  assert.deepEqual(repeated.state.choices,prompt.state.choices);
  const selected=routeSharedEvent(repeated.state,text(" opaque-2 ",now+5000),active,now+5000);
  assert.equal(selected.action,"entered");assert.equal(selected.tenantId,"merchant-b");assert.equal(selected.state.choices,undefined);
  assert.equal(routeSharedEvent(prompt.state,text("opaque-2",now+6000),new Set(["merchant-a"]),now+6000).reason,"invalid_choice");
  assert.equal(routeSharedEvent(prompt.state,text("opaque-2",now+700000),active,now+700000).reason,"invalid_choice");
  const renewed=routeSharedEvent(prompt.state,text("切换商家",now+6000),active,now+6000,()=>"renewed");
  assert.notDeepEqual(renewed.state.choices,prompt.state.choices);
});

test("disabling the selected merchant never silently reroutes to another merchant", () => {
  const state = initial(); state.associations = [{ tenantId: "merchant-a", name: "A" }, { tenantId: "merchant-b", name: "B" }];
  state.selected = { tenantId: "merchant-a", expiresAt: now + 999_000 };
  const result = routeSharedEvent(state, text("private question for A"), new Set(["merchant-b"]), now + 3000);
  assert.equal(result.action, "choose"); assert.equal(result.tenantId, undefined);
});
