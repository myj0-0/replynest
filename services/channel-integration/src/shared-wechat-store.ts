import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { extractSharedScene, sceneDigest, routeSharedEvent, type RoutingEvent, type RoutingResult, type RoutingState } from "./shared-wechat-routing.js";
import type {WeChatMedia} from './wechat-media-core.js';

/** Staging migration: gateway invokes only when the separate callback gate is enabled. */
export function sharedWechatStoreSchemaSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS shared_wechat_accounts (
      app_id TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT FALSE
    );
    ALTER TABLE shared_wechat_accounts ADD COLUMN IF NOT EXISTS default_tenant_id TEXT REFERENCES tenants(tenant_id);
    CREATE TABLE IF NOT EXISTS shared_wechat_enrollments (
      app_id TEXT NOT NULL REFERENCES shared_wechat_accounts(app_id),
      tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id), enabled BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY(app_id,tenant_id)
    );
    CREATE TABLE IF NOT EXISTS shared_wechat_scenes (
      app_id TEXT NOT NULL, digest TEXT NOT NULL CHECK(length(digest)=64),
      tenant_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY(app_id,digest), FOREIGN KEY(app_id,tenant_id) REFERENCES shared_wechat_enrollments(app_id,tenant_id)
    );
    CREATE TABLE IF NOT EXISTS shared_wechat_inboxes (
      app_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
      account_id BIGINT NOT NULL CHECK(account_id>0), inbox_id BIGINT NOT NULL CHECK(inbox_id>0),
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY(app_id,tenant_id), UNIQUE(account_id,inbox_id),
      FOREIGN KEY(app_id,tenant_id) REFERENCES shared_wechat_enrollments(app_id,tenant_id)
    );
    ALTER TABLE shared_wechat_scenes ALTER COLUMN expires_at DROP NOT NULL;
    CREATE TABLE IF NOT EXISTS shared_wechat_routing_states (
      app_id TEXT NOT NULL REFERENCES shared_wechat_accounts(app_id), open_id TEXT NOT NULL,
      state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(app_id,open_id)
    );
    CREATE TABLE IF NOT EXISTS shared_wechat_receipts (
      app_id TEXT NOT NULL REFERENCES shared_wechat_accounts(app_id), event_id TEXT NOT NULL,
      open_id TEXT NOT NULL, request_hash TEXT NOT NULL, decision JSONB NOT NULL,
      destination_tenant_id TEXT, route_version INTEGER NOT NULL,
      text_content TEXT, delivery_state TEXT NOT NULL DEFAULT 'held' CHECK(delivery_state IN ('held','ignored')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(app_id,event_id),
      FOREIGN KEY(app_id,destination_tenant_id) REFERENCES shared_wechat_enrollments(app_id,tenant_id)
    );
    -- Do not backfill old receipts with ingestion time: they are not eligible for automatic sending.
    ALTER TABLE shared_wechat_receipts ADD COLUMN IF NOT EXISTS source_occurred_at TIMESTAMPTZ;
    ALTER TABLE shared_wechat_receipts ADD COLUMN IF NOT EXISTS media_payload JSONB;
  `;
}
export async function migrateSharedWechatStore(db: Pool) {
  await db.query(sharedWechatStoreSchemaSql());
}

/** Resolve ONLY the immutable receipt destination, never the user's current selection.
 * This is a staging preflight, not authorization to send: the eventual dispatcher must
 * recheck these gates in its claim transaction and verify the upstream inbox account.
 * No fallback to global CHATWOOT_ACCOUNT_ID / CHATWOOT_INBOX_IDENTIFIER is allowed.
 */
export async function resolveSharedWechatDelivery(db: Pool, appId: string, eventId: string) {
  const result = await db.query(`
    SELECT r.destination_tenant_id AS tenant_id,i.account_id::text,i.inbox_id::text,
           r.open_id,r.text_content,r.route_version
    FROM shared_wechat_receipts r
    JOIN shared_wechat_accounts a ON a.app_id=r.app_id AND a.enabled=TRUE
    JOIN shared_wechat_enrollments e ON e.app_id=r.app_id AND e.tenant_id=r.destination_tenant_id AND e.enabled=TRUE
    JOIN tenants t ON t.tenant_id=e.tenant_id AND t.status IN ('active','test')
    JOIN shared_wechat_inboxes i ON i.app_id=e.app_id AND i.tenant_id=e.tenant_id AND i.enabled=TRUE
      AND i.account_id=t.chatwoot_account_id
    WHERE r.app_id=$1 AND r.event_id=$2 AND r.delivery_state='held'
      AND r.decision->>'action'='route' AND r.text_content IS NOT NULL
  `,[appId,eventId]);
  const row = result.rows[0];
  if (!row) throw new Error("shared_delivery_not_ready");
  // Internal transport data; never expose open_id across tenants or as a public API response.
  return { appId, eventId, tenantId: String(row.tenant_id), accountId: String(row.account_id),
    inboxId: String(row.inbox_id), openId: String(row.open_id), content: String(row.text_content),
    routeVersion: Number(row.route_version) };
}

export type VerifiedSharedEvent = {
  // Caller must verify callback signature/decryption and expected receiver first.
  appId: string; openId: string; eventId: string; occurredAt: number;
  kind: "scan" | "text" | "media" | "unsubscribe" | "service"; text?: string; event?: string; eventKey?: string; media?:WeChatMedia;
};

/** Holds a durable decision; deliberately does not send to the legacy fixed inbox.
 * Duplicate callback returns original decision even after merchant selection changes.
 */
export async function recordSharedWechatEvent(db: Pool, input: VerifiedSharedEvent): Promise<{ duplicate: boolean; decision: RoutingResult }> {
  if (!input.appId || !input.openId || input.openId.length > 200 || !input.eventId || input.eventId.length > 200 || (input.text?.length ?? 0) > 10000 ||
      !Number.isSafeInteger(input.occurredAt) || input.occurredAt<0 || input.occurredAt>8640000000000000) throw new Error("invalid_shared_event");
  const hashParts:unknown[]=[input.appId,input.openId,input.eventId,input.occurredAt,input.kind,input.text ?? "",input.event ?? "",input.eventKey ?? ""];
  if(input.kind==='media'){if(!input.media)throw Error('invalid_shared_media');hashParts.push(input.media);}
  const hash = createHash("sha256").update(JSON.stringify(hashParts)).digest("hex");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Lock identity, not tenant: one shared user may switch merchants concurrently.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`shared-wechat:${input.appId}:${input.openId}`]);
    const previous = await client.query(`SELECT request_hash,decision FROM shared_wechat_receipts WHERE app_id=$1 AND event_id=$2`, [input.appId,input.eventId]);
    if (previous.rows[0]) {
      if (previous.rows[0].request_hash !== hash) throw new Error("shared_event_conflict");
      await client.query("COMMIT"); return { duplicate: true, decision: previous.rows[0].decision };
    }
    const account = await client.query(`SELECT app_id,default_tenant_id FROM shared_wechat_accounts WHERE app_id=$1 AND enabled=TRUE FOR SHARE`, [input.appId]);
    if (!account.rows[0]) throw new Error("shared_account_disabled");
    const grants = await client.query(`SELECT e.tenant_id,t.name FROM shared_wechat_enrollments e JOIN tenants t ON t.tenant_id=e.tenant_id WHERE e.app_id=$1 AND e.enabled=TRUE AND t.status IN ('active','test') FOR SHARE OF e,t`, [input.appId]);
    const active = new Set<string>(grants.rows.map(row => row.tenant_id));
    const nowResult = await client.query(`SELECT EXTRACT(EPOCH FROM clock_timestamp())*1000 AS now`);
    // PostgreSQL epoch milliseconds retain microseconds. Persist whole
    // milliseconds like verified callback timestamps and H5 selection fences.
    const now = Math.floor(Number(nowResult.rows[0].now));
    const stored = await client.query(`SELECT state FROM shared_wechat_routing_states WHERE app_id=$1 AND open_id=$2 FOR UPDATE`, [input.appId,input.openId]);
    const state: RoutingState = stored.rows[0]?.state ?? { appId: input.appId, openId: input.openId, associations: [], lastTransitionAt: 0, version: 0 };
    let event: RoutingEvent;
    if (input.kind === "scan") {
      const token = extractSharedScene(input.event ?? "",input.eventKey ?? "");
      const found = token ? await client.query(`SELECT tenant_id,expires_at,revoked FROM shared_wechat_scenes WHERE app_id=$1 AND digest=$2 FOR SHARE`, [input.appId,sceneDigest(token)]) : { rows: [] };
      const row = found.rows[0];
      event = { ...input, kind: "scan", scene: row ? { appId: input.appId, tenantId: row.tenant_id, name: grants.rows.find(g => g.tenant_id === row.tenant_id)?.name ?? "", expiresAt: row.expires_at===null?Number.MAX_SAFE_INTEGER:new Date(row.expires_at).getTime(), revoked: row.revoked } : null };
    } else if (input.kind === "text") event = { ...input, kind: "text", text: input.text ?? "" };
    else if(input.kind==='media')event={...input,kind:'media'};
    else event = { ...input, kind: input.kind==='service'?'service':'unsubscribe' };
    // Only truly parameterless subscribe is generic. Invalid/expired/unknown scenes never fall back.
    if(input.kind==='scan'&&input.event==='subscribe'&&!input.eventKey)event={...input,kind:'entry'};
    const defaultId=account.rows[0].default_tenant_id;
    const defaultGrant=grants.rows.find(g=>g.tenant_id===defaultId);
    const ready=defaultGrant?await client.query(`SELECT 1 FROM shared_wechat_inboxes i JOIN tenants t ON t.tenant_id=i.tenant_id AND t.chatwoot_account_id=i.account_id WHERE i.app_id=$1 AND i.tenant_id=$2 AND i.enabled=TRUE FOR SHARE OF i,t`,[input.appId,defaultId]):{rowCount:0};
    const decision = routeSharedEvent(state,event,active,now,undefined,ready.rowCount?{tenantId:defaultId,name:defaultGrant!.name}:undefined);
    if(event.kind==='scan' && event.scene && ['entered','choose'].includes(decision.action))decision.scannedTenantId=event.scene.tenantId;
    await client.query(`INSERT INTO shared_wechat_routing_states(app_id,open_id,state) VALUES($1,$2,$3) ON CONFLICT(app_id,open_id) DO UPDATE SET state=EXCLUDED.state,updated_at=NOW()`, [input.appId,input.openId,decision.state]);
    await client.query(`INSERT INTO shared_wechat_receipts(app_id,event_id,open_id,request_hash,decision,destination_tenant_id,route_version,text_content,delivery_state,source_occurred_at,media_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [input.appId,input.eventId,input.openId,hash,decision,decision.action === "route" ? decision.tenantId : null,decision.state.version,decision.action === "route" ? input.text : null,decision.action === "ignore" ? "ignored" : "held",new Date(input.occurredAt),decision.action==='route'?input.media??null:null]);
    await client.query("COMMIT"); return { duplicate: false, decision };
  } catch(error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
