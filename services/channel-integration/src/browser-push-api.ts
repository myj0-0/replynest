import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { saveBrowserSubscription, sendBrowserPush } from "./browser-push.js";
import { browserPushConfig, validateBrowserSubscription } from "./browser-push-core.js";
import { readBody, sendJson } from "./shared.js";

type Auth = { tenant_id: string; actor_id: string; auth_kind: "api_key" | "console_session"; platform_user_id: string | null };
async function input(request: IncomingMessage) { return JSON.parse((await readBody(request)).toString("utf8")) as Record<string, unknown>; }

export async function handleBrowserPushApi(request: IncomingMessage, response: ServerResponse, url: URL, auth: Auth, requestId: string) {
  if (!url.pathname.startsWith("/api/v1/browser-push")) return false;
  const config = browserPushConfig();
  if (request.method === "GET" && url.pathname === "/api/v1/browser-push/config") {
    sendJson(response, 200, { request_id: requestId, data: { enabled: config.enabled, public_key: config.enabled ? config.public_key : null } }); return true;
  }
  if (auth.auth_kind !== "console_session" || !auth.platform_user_id) {
    sendJson(response, 403, { request_id: requestId, error: { code: "console_identity_required", message: "需要已登录的控制台成员身份" } }); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/browser-push/subscriptions/status") {
    try {
      const body=await input(request);
      if(body.expected_tenant_id!==auth.tenant_id || body.expected_user_id!==auth.platform_user_id) {
        sendJson(response,409,{error:{code:"workspace_changed"}});return true;
      }
      const value=validateBrowserSubscription(body);
      const found=await pool.query(`SELECT 1 FROM browser_push_subscriptions WHERE tenant_id=$1 AND platform_user_id=$2 AND endpoint_hash=$3 AND status='active'`,[auth.tenant_id,auth.platform_user_id,value.endpoint_hash]);
      sendJson(response,200,{data:{active:!!found.rows[0]}});
    } catch {sendJson(response,400,{error:{code:"invalid_push_subscription"}});}
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/browser-push/subscriptions") {
    const result = await pool.query(`SELECT subscription_id,device_label,status,last_success_at,created_at,updated_at
      FROM browser_push_subscriptions WHERE tenant_id=$1 AND platform_user_id=$2 AND status<>'revoked' ORDER BY updated_at DESC`, [auth.tenant_id, auth.platform_user_id]);
    sendJson(response, 200, { request_id: requestId, data: result.rows }); return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/browser-push/subscriptions") {
    if (!config.enabled) { sendJson(response, 503, { request_id: requestId, error: { code: "browser_push_disabled", message: "Browser Push尚未配置" } }); return true; }
    try {
      const body=await input(request);
      if((body.expected_tenant_id!==undefined && body.expected_tenant_id!==auth.tenant_id) || (body.expected_user_id!==undefined && body.expected_user_id!==auth.platform_user_id)) {
        sendJson(response,409,{error:{code:"workspace_changed"}});return true;
      }
      const saved = await saveBrowserSubscription(auth.tenant_id, auth.platform_user_id, body, request.headers["user-agent"]);
      await pool.query(`INSERT INTO notification_preferences (tenant_id,channels,updated_by)
        VALUES ($1,ARRAY['in_app','browser_push']::TEXT[],$2)
        ON CONFLICT (tenant_id) DO UPDATE SET channels=CASE WHEN notification_preferences.channels @> ARRAY['browser_push']::TEXT[]
          THEN notification_preferences.channels ELSE array_append(notification_preferences.channels,'browser_push') END,updated_by=$2,updated_at=NOW()`,
        [auth.tenant_id, auth.actor_id]);
      await pool.query(`INSERT INTO audit_logs (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
        VALUES ($1,$2,$3,'browser_push.subscribed','browser_push_subscription',$4,jsonb_build_object('device_label',$5::text),$6)`,
        [auth.tenant_id, auth.auth_kind, auth.actor_id, saved.subscription_id, saved.device_label, requestId]);
      let testStatus = "delivered";
      try {
        testStatus = await sendBrowserPush(saved.subscription_id, auth.tenant_id, {
          title: "Browser Push 已启用", summary: "ReplyNest 可以在此设备上发送运营提醒。本测试不包含客户数据。",
          severity: "info", notification_id: randomUUID(),
        });
      } catch { testStatus = "failed"; }
      sendJson(response, 201, { request_id: requestId, data: { ...saved, test_status: testStatus } });
    } catch (error) { sendJson(response, 400, { request_id: requestId, error: { code: "invalid_push_subscription", message: "浏览器订阅格式不正确" } }); }
    return true;
  }
  if (request.method === "DELETE" && url.pathname === "/api/v1/browser-push/subscriptions/current") {
    try {
      const value = validateBrowserSubscription(await input(request));
      const result = await pool.query(`UPDATE browser_push_subscriptions SET status='revoked',updated_at=NOW()
        WHERE tenant_id=$1 AND platform_user_id=$2 AND endpoint_hash=$3 AND status<>'revoked' RETURNING subscription_id`,
        [auth.tenant_id, auth.platform_user_id, value.endpoint_hash]);
      const remaining = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM browser_push_subscriptions WHERE tenant_id=$1 AND status='active'`, [auth.tenant_id]);
      if (remaining.rows[0]?.count === "0") await pool.query(`UPDATE notification_preferences SET channels=array_remove(channels,'browser_push'),updated_at=NOW() WHERE tenant_id=$1`, [auth.tenant_id]);
      sendJson(response, result.rows[0] ? 200 : 404, { request_id: requestId, data: result.rows[0] ?? null });
    } catch { sendJson(response, 400, { request_id: requestId, error: { code: "invalid_push_subscription", message: "浏览器订阅格式不正确" } }); }
    return true;
  }
  const match = url.pathname.match(/^\/api\/v1\/browser-push\/subscriptions\/([0-9a-f-]{36})$/i);
  if (request.method === "DELETE" && match) {
    const result = await pool.query(`UPDATE browser_push_subscriptions SET status='revoked',updated_at=NOW()
      WHERE subscription_id=$1 AND tenant_id=$2 AND platform_user_id=$3 AND status<>'revoked' RETURNING subscription_id`,
      [match[1], auth.tenant_id, auth.platform_user_id]);
    sendJson(response, result.rows[0] ? 200 : 404, { request_id: requestId, data: result.rows[0] ?? null }); return true;
  }
  sendJson(response, 404, { request_id: requestId, error: { code: "not_found", message: "Browser Push接口不存在" } }); return true;
}
