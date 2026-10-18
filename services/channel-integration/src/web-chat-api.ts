import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "./database.js";
import { readBody, sendJson, requiredEnv } from "./shared.js";
import { assertCapacity, EntitlementLimitError } from "./subscriptions.js";
import { webChatInput, widgetLoader } from "./web-chat-core.js";

type Auth = { tenant_id: string; role: string; platform_user_id: string | null; auth_kind: string };
async function chatwoot(path: string, method = "GET", body?: unknown): Promise<any> {
  const result = await fetch(`${requiredEnv("CHATWOOT_BASE_URL").replace(/\/$/, "")}/api/v1${path}`, {
    method, headers: { api_access_token: requiredEnv("CHATWOOT_API_ACCESS_TOKEN"), "content-type": "application/json", "x-forwarded-proto": "https" },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10000)
  });
  if (!result.ok) throw new Error(`web_chat_upstream_${result.status}`);
  return result.json();
}
export async function handlePublicWebChat(request: IncomingMessage, response: ServerResponse, url: URL) {
  const match = url.pathname.match(/^\/api\/v1\/public\/web-chat\/([0-9a-f-]{36})\/loader$/i);
  if (!match || request.method !== "GET") return false;
  const result = await pool.query(`SELECT c.configuration FROM channel_connections c JOIN tenants t ON t.tenant_id=c.tenant_id WHERE c.connection_id=$1 AND c.channel_type='web_chat' AND c.status='ready' AND t.status IN ('active','test')`, [match[1]]);
  const configuration = result.rows[0]?.configuration;
  if (!configuration?.website_token) { sendJson(response, 404, { error: { code: "web_chat_not_available" } }); return true; }
  response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(widgetLoader(requiredEnv("CHATWOOT_PUBLIC_URL"), configuration.website_token)); return true;
}
export async function handleWebChatApi(request: IncomingMessage, response: ServerResponse, url: URL, auth: Auth, requestId: string) {
  if (url.pathname !== "/api/v1/channels/web-chat" || !["GET", "POST"].includes(request.method ?? "")) return false;
  const respond = (status: number, body: unknown) => sendJson(response, status, body);
  if (auth.auth_kind !== "console_session" || auth.role !== "tenant_admin" || !auth.platform_user_id) { respond(403, { error: { code: "tenant_admin_required" } }); return true; }
  if (request.method === "GET") {
    const result = await pool.query(`SELECT connection_id,display_name,status,configuration->>'website_url' AS website_url FROM channel_connections WHERE tenant_id=$1 AND channel_type='web_chat' ORDER BY created_at LIMIT 1`, [auth.tenant_id]);
    respond(200, { data: result.rows[0] ?? null }); return true;
  }
  let raw: unknown; try { raw = JSON.parse((await readBody(request)).toString("utf8")); } catch { raw = null; }
  const input = webChatInput(raw);
  if (!input) { respond(400, { error: { code: "invalid_website" } }); return true; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One website inbox per tenant in the first increment; retry uses a stable upstream name.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`web-chat:${auth.tenant_id}`]);
    const tenant = await client.query(`SELECT chatwoot_account_id::text FROM tenants WHERE tenant_id=$1 AND status IN ('active','test') FOR UPDATE`, [auth.tenant_id]);
    const account = tenant.rows[0]?.chatwoot_account_id;
    if (!account || !/^\d+$/.test(account)) throw new Error("account_not_configured");
    const existing = await client.query(`SELECT connection_id,status,configuration FROM channel_connections WHERE tenant_id=$1 AND channel_type='web_chat' ORDER BY created_at LIMIT 1 FOR UPDATE`, [auth.tenant_id]);
    if (existing.rows[0]?.status === "ready") {
      await client.query("ROLLBACK"); respond(409, { error: { code: "website_already_connected" } }); return true;
    }
    const used = await client.query(`SELECT COUNT(*)::int AS count FROM channel_connections WHERE tenant_id=$1 AND status='ready' AND COALESCE(configuration->>'mode','')<>'synthetic'`, [auth.tenant_id]);
    await assertCapacity(auth.tenant_id, "channel_limit", used.rows[0].count, 1, client);
    const marker = `ReplyNest Web ${auth.tenant_id}`;
    const listed = await chatwoot(`/accounts/${account}/inboxes`);
    let inbox = (listed.payload ?? []).find((item: any) => item.name === marker && item.channel_type === "Channel::WebWidget");
    if (!inbox) inbox = await chatwoot(`/accounts/${account}/inboxes`, "POST", {
      name: marker, enable_auto_assignment: true, enable_email_collect: false, greeting_enabled: false,
      channel: { type: "web_widget", website_url: input.website_url, welcome_title: input.display_name, welcome_tagline: "Send us a message · 给我们留言", widget_color: "#2095FF", selected_feature_flags: ["attachments", "emoji_picker", "end_conversation"] }
    });
    if (!Number.isSafeInteger(inbox.id) || typeof inbox.website_token !== "string" || !inbox.website_token) throw new Error("invalid_website_inbox");
    const members = await client.query(`SELECT chatwoot_user_id::int AS id FROM tenant_memberships WHERE tenant_id=$1 AND chatwoot_account_id=$2 AND status='active' AND chatwoot_sync_status='synced' AND chatwoot_user_id IS NOT NULL`, [auth.tenant_id, account]);
    if (!members.rows.length) throw new Error("no_active_agents");
    await chatwoot(`/accounts/${account}/inbox_members`, "POST", { inbox_id: inbox.id, user_ids: members.rows.map(item => item.id) });
    const configuration = { mode: "live", website_url: input.website_url, chatwoot_account_id: account, chatwoot_inbox_id: String(inbox.id), website_token: inbox.website_token };
    const saved = existing.rows[0] ? await client.query(`UPDATE channel_connections SET display_name=$3,status='ready',configuration=$4,external_account_id=$5,last_checked_at=NOW(),updated_at=NOW() WHERE tenant_id=$1 AND connection_id=$2 RETURNING connection_id,display_name,status,configuration->>'website_url' AS website_url`, [auth.tenant_id, existing.rows[0].connection_id, input.display_name, configuration, String(inbox.id)])
      : await client.query(`INSERT INTO channel_connections(tenant_id,channel_type,display_name,status,configuration,external_account_id,last_checked_at) VALUES($1,'web_chat',$2,'ready',$3,$4,NOW()) RETURNING connection_id,display_name,status,configuration->>'website_url' AS website_url`, [auth.tenant_id, input.display_name, configuration, String(inbox.id)]);
    await client.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id) VALUES($1,'platform_user',$2,'channel.web_chat.created','channel_connection',$3,$4,$5)`, [auth.tenant_id, auth.platform_user_id, saved.rows[0].connection_id, { website_url: input.website_url }, requestId]);
    await client.query("COMMIT");
    // Rename only after committing the mapping: failed provisioning can still be
    // recovered by its stable marker, while visitors see the tenant's chosen name.
    try { await chatwoot(`/accounts/${account}/inboxes/${inbox.id}`, "PATCH", { name: input.display_name }); }
    catch { console.warn("Web chat display name update pending"); }
    respond(201, { data: saved.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof EntitlementLimitError) respond(409, { error: { code: "entitlement_limit_reached" } });
    else { console.warn("Web chat setup failed", error instanceof Error ? error.message : "unknown"); respond(503, { error: { code: "web_chat_setup_unconfirmed" } }); }
  } finally { client.release(); }
  return true;
}

// Called only on account-checked upstream conversations, never on unauthenticated webhook payloads.
export async function syncWebChatContact(tenantId: string, accountId: string, raw: Record<string, any>) {
  if (String(raw.account_id) !== accountId || !/^\d+$/.test(String(raw.id))) return;
  const connection = await pool.query(`SELECT connection_id FROM channel_connections WHERE tenant_id=$1 AND channel_type='web_chat' AND configuration->>'chatwoot_account_id'=$2 AND configuration->>'chatwoot_inbox_id'=$3 AND status='ready'`, [tenantId, accountId, String(raw.inbox_id)]);
  if (!connection.rows[0]) return;
  const sender = raw.meta?.sender;
  if (!sender || !/^\d+$/.test(String(sender.id))) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`web-contact:${tenantId}:${sender.id}`]);
    const exists = await client.query(`SELECT 1 FROM channel_identities WHERE tenant_id=$1 AND channel='web_chat' AND chatwoot_conversation_id=$2`, [tenantId, String(raw.id)]);
    if (!exists.rows.length) {
      const known = await client.query(`SELECT customer_id FROM channel_identities WHERE tenant_id=$1 AND channel='web_chat' AND chatwoot_contact_id=$2 AND customer_id IS NOT NULL LIMIT 1`, [tenantId, sender.id]);
      const customer = known.rows.length ? known : await client.query(`INSERT INTO customers(tenant_id,name,email,phone) VALUES($1,$2,$3,$4) RETURNING customer_id`, [tenantId, typeof sender.name === "string" ? sender.name.slice(0,200) : "Website visitor", typeof sender.email === "string" ? sender.email.slice(0,320) : null, typeof sender.phone_number === "string" ? sender.phone_number.slice(0,64) : null]);
      await client.query(`INSERT INTO channel_identities(tenant_id,customer_id,channel,external_user_id,chatwoot_contact_id,chatwoot_source_id,chatwoot_conversation_id,channel_connection_id) VALUES($1,$2,'web_chat',$3,$4,$5,$6,$7)`, [tenantId, customer.rows[0].customer_id, `${sender.id}:${raw.id}`, sender.id, `web:${sender.id}`, raw.id, connection.rows[0].connection_id]);
    }
    await client.query("COMMIT");
  } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
