import { createHash, randomBytes } from "node:crypto";

/** Pure routing domain. Call ONLY after callback signature/AppID verification.
 * Persist state, dedup receipt and returned destination in ONE transaction under
 * an (appId, openId) lock. Never recompute a destination when retrying delivery.
 */
export type Association = { tenantId: string; name: string };
export type RoutingState = {
  appId: string; openId: string; associations: Association[];
  selected?: { tenantId: string; expiresAt: number };
  choices?: { expiresAt: number; items: { tenantId: string; code: string }[] };
  lastTransitionAt: number; version: number;
  needsMerchantEntry?: boolean;
};
export type Scene = { appId: string; tenantId: string; name: string; expiresAt: number; revoked: boolean };
export type RoutingEvent = {
  appId: string; openId: string; eventId: string; occurredAt: number;
} & ({ kind: "scan"; scene: Scene | null } | { kind: "text"; text: string } | { kind: "media" } | { kind: "unsubscribe" | "entry" | "service" });
export type RoutingResult = {
  state: RoutingState;
  action: "route" | "choose" | "entered" | "info" | "ignore" | "unlinked";
  scannedTenantId?: string;
  tenantId?: string;
  reason?: string;
};

export function sceneToken(): { value: string; digest: string } {
  const value = `rn_${randomBytes(24).toString("base64url")}`;
  return { value, digest: sceneDigest(value) };
}
export function sceneDigest(value: string): string {
  if (!/^rn_[A-Za-z0-9_-]{32}$/.test(value)) throw new Error("invalid_shared_scene");
  return createHash("sha256").update(value).digest("hex");
}
export function extractSharedScene(event: string, eventKey: string): string | null {
  const value = event === "subscribe" ? eventKey.replace(/^qrscene_/, "") : event === "SCAN" ? eventKey : "";
  return /^rn_[A-Za-z0-9_-]{32}$/.test(value) ? value : null;
}

export function routeSharedEvent(
  prior: RoutingState, event: RoutingEvent, activeTenantIds: ReadonlySet<string>, now: number,
  makeChoice = () => randomBytes(12).toString("base64url"), defaultMerchant?: Association
): RoutingResult {
  if (prior.appId !== event.appId || prior.openId !== event.openId) throw new Error("shared_identity_mismatch");
  if (!Number.isFinite(now) || !Number.isFinite(event.occurredAt) || event.occurredAt > now + 60_000 || !event.eventId) throw new Error("invalid_shared_event");
  const state: RoutingState = structuredClone(prior);
  const ignore = (reason: string): RoutingResult => ({ state, action: "ignore", reason });
  // Conservative: same-second transition events do not silently supersede a choice.
  if (event.occurredAt <= state.lastTransitionAt) return ignore("stale_event");
  const transition = () => { state.version += 1; state.lastTransitionAt = event.occurredAt; };
  const eligible = () => state.associations.filter(a => activeTenantIds.has(a.tenantId));
  const choose = (renew = false): RoutingResult => {
    state.selected = undefined;
    const items = eligible();
    if (!renew && state.choices && state.choices.expiresAt > now &&
      state.choices.items.length === items.length && state.choices.items.every(c => items.some(a => a.tenantId === c.tenantId))) {
      return { state, action: "choose" };
    }
    state.choices = { expiresAt: now + 10 * 60_000, items: eligible().map(a => ({ tenantId: a.tenantId, code: makeChoice() })) };
    transition();
    return { state, action: "choose" };
  };
  if (event.kind === "unsubscribe") {
    state.associations = []; state.selected = undefined; state.choices = undefined;
    state.needsMerchantEntry=undefined;
    transition(); return { state, action: "unlinked" };
  }
  if (event.kind === "scan") {
    const scene = event.scene;
    if (!scene || scene.appId !== event.appId || scene.revoked || scene.expiresAt <= now || !activeTenantIds.has(scene.tenantId)) {state.needsMerchantEntry=true;transition();return ignore("invalid_scene");}
    state.needsMerchantEntry=undefined;
    if (!state.associations.some(a => a.tenantId === scene.tenantId)) state.associations.push({ tenantId: scene.tenantId, name: scene.name });
    if (state.associations.length !== 1) return choose(true);
    state.selected = { tenantId: scene.tenantId, expiresAt: now + 30 * 60_000 };
    state.choices = undefined; transition();
    return { state, action: "entered", tenantId: scene.tenantId };
  }
  if(!state.associations.length&&!state.needsMerchantEntry&&defaultMerchant&&activeTenantIds.has(defaultMerchant.tenantId)) {
    state.associations.push({...defaultMerchant});transition();
  }
  // Entry/menu events may show context but must never create a customer business message.
  if(event.kind==='entry'||event.kind==='service'){
    const available=eligible();
    const selected=state.selected&&state.selected.expiresAt>now?available.find(a=>a.tenantId===state.selected!.tenantId):undefined;
    const target=state.associations.length===1&&available.length===1?available[0]:selected;
    if(target)return {state,action:'info',tenantId:target.tenantId};
    return available.length?choose():ignore('no_active_association');
  }
  if(event.kind!=='text'&&event.kind!=='media')return ignore('unsupported_event');
  const text=event.kind==='text'?event.text.trim():'';
  const command = text.match(/^(?:选择|select)\s+(\S+)$/i);
  const bareChoice = state.choices?.items.find(item => item.code === text);
  if (command || bareChoice) {
    const choice = state.choices?.expiresAt && state.choices.expiresAt > now
      ? state.choices.items.find(item => item.code === (command?.[1] ?? bareChoice?.code) && activeTenantIds.has(item.tenantId)) : undefined;
    if (!choice || !state.associations.some(a => a.tenantId === choice.tenantId)) return ignore("invalid_choice");
    state.selected = { tenantId: choice.tenantId, expiresAt: now + 30 * 60_000 };
    state.choices = undefined; transition();
    return { state, action: "entered", tenantId: choice.tenantId };
  }
  const active = eligible();
  if (!active.length) return ignore("no_active_association");
  if (/^(切换商家|switch merchant)$/i.test(text)) return choose(true);
  if (state.associations.length === 1 && active.length === 1) return { state, action: "route", tenantId: active[0].tenantId };
  if (state.selected && state.selected.expiresAt > now && activeTenantIds.has(state.selected.tenantId) && active.some(a => a.tenantId === state.selected!.tenantId)) {
    return { state, action: "route", tenantId: state.selected.tenantId };
  }
  return choose();
}
