import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "./database.js";
import { encryptWebhookSecret } from "./notification-webhook-crypto.js";
import { testWebhookDestination } from "./notification-gateway.js";
import {WEBHOOK_TEST_EVENT} from './notification-webhook-retry.js';
import { validateWebhookEndpoint, type WebhookProvider } from "./notification-webhook-adapter.js";
import { readBody, sendJson } from "./shared.js";

type DestinationAuth = {
  tenant_id: string;
  role: "tenant_admin" | "supervisor" | "agent";
  actor_id: string;
  auth_kind: "api_key" | "console_session";
  platform_user_id: string | null;
};

function result(response: ServerResponse, status: number, requestId: string, body: Record<string, unknown>) {
  sendJson(response, status, { request_id: requestId, ...body });
}

async function jsonInput(request: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse((await readBody(request)).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error("invalid_json");
  }
}

function providerValue(value: unknown): WebhookProvider {
  const provider = String(value) as WebhookProvider;
  if (!['feishu', 'wecom', 'dingtalk', 'custom'].includes(provider)) throw new Error("不支持的 Webhook 类型");
  return provider;
}

function displayName(value: unknown): string {
  const name = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name || name.length > 80) throw new Error("名称长度必须为 1-80 个字符");
  return name;
}

async function audit(auth: DestinationAuth, requestId: string, action: string, destinationId: string, afterData: Record<string, unknown>) {
  await pool.query(
    `INSERT INTO audit_logs
      (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
     VALUES ($1,$2,$3,$4,'notification_webhook_destination',$5,$6,$7)`,
    [auth.tenant_id, auth.auth_kind, auth.actor_id, action, destinationId, afterData, requestId],
  );
}

export async function handleNotificationDestinationsApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  auth: DestinationAuth,
  requestId: string,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/v1/notification-destinations")) return false;
  if (auth.role !== "tenant_admin") {
    result(response, 403, requestId, { error: { code: "admin_required", message: "仅企业管理员可以配置通知 Webhook" } });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/notification-destinations") {
    const destinations = await pool.query(
      `SELECT destination_id,provider,display_name,endpoint_host,status,last_tested_at,last_test_status,last_error_code,
              (SELECT jsonb_build_object('status',d.status,'attempt_count',d.attempt_count,'next_attempt_at',d.next_attempt_at,'error_code',d.error_code)
               FROM notification_deliveries d JOIN notification_events e ON e.notification_id=d.notification_id AND e.tenant_id=d.tenant_id
               WHERE d.tenant_id=notification_webhook_destinations.tenant_id AND d.target_ref=notification_webhook_destinations.destination_id::text
                AND d.channel='webhook' AND e.event_type=$2 ORDER BY d.created_at DESC,d.delivery_id DESC LIMIT 1) AS test_delivery,
              (signing_secret_ciphertext IS NOT NULL) AS signing_configured,created_at,updated_at
         FROM notification_webhook_destinations WHERE tenant_id=$1 ORDER BY created_at`,
      [auth.tenant_id,WEBHOOK_TEST_EVENT],
    );
    result(response, 200, requestId, { data: destinations.rows });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/notification-destinations") {
    try {
      const input = await jsonInput(request);
      const provider = providerValue(input.provider);
      const endpoint = validateWebhookEndpoint(provider, String(input.endpoint ?? ""));
      const name = displayName(input.display_name);
      const signingSecret = String(input.signing_secret ?? "").trim();
      if (signingSecret && (provider !== "custom" || signingSecret.length < 16 || signingSecret.length > 256)) {
        throw new Error("自定义 Webhook 签名密钥长度必须为 16-256 个字符");
      }
      const inserted = await pool.query(
        `INSERT INTO notification_webhook_destinations
          (tenant_id,provider,display_name,endpoint_ciphertext,signing_secret_ciphertext,endpoint_host,created_by,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
         RETURNING destination_id,provider,display_name,endpoint_host,status,created_at,updated_at`,
        [auth.tenant_id, provider, name, encryptWebhookSecret(endpoint.toString()),
         signingSecret ? encryptWebhookSecret(signingSecret) : null, endpoint.hostname, auth.platform_user_id],
      );
      await audit(auth, requestId, "notification_destination.created", inserted.rows[0].destination_id, {
        provider, display_name: name, endpoint_host: endpoint.hostname,
      });
      result(response, 201, requestId, { data: inserted.rows[0] });
    } catch (error: any) {
      const duplicate = error?.code === "23505";
      result(response, duplicate ? 409 : 400, requestId, { error: {
        code: duplicate ? "destination_name_conflict" : "invalid_notification_destination",
        message: duplicate ? "通知目标名称已存在" : error instanceof Error ? error.message : "通知目标不正确",
      } });
    }
    return true;
  }

  const match = url.pathname.match(/^\/api\/v1\/notification-destinations\/([0-9a-f-]{36})(?:\/(test))?$/i);
  if (!match) {
    result(response, 404, requestId, { error: { code: "not_found", message: "通知目标接口不存在" } });
    return true;
  }
  const destinationId = match[1];
  if (request.method === "POST" && match[2] === "test") {
    try {
      const queued = await testWebhookDestination(auth.tenant_id, destinationId);
      await audit(auth, requestId, "notification_destination.test_queued", destinationId, { delivery_id: queued.delivery_id });
      result(response, 202, requestId, { data: { destination_id: destinationId, queued: true, delivery: queued } });
    } catch {
      await audit(auth, requestId, "notification_destination.test_failed", destinationId, { delivered: false });
      result(response, 502, requestId, { error: { code: "webhook_test_failed", message: "测试通知发送失败，请检查地址和机器人安全规则" } });
    }
    return true;
  }
  if (request.method === "PUT" && !match[2]) {
    try {
      const input = await jsonInput(request);
      const current = await pool.query<{ provider: WebhookProvider }>(
        `SELECT provider FROM notification_webhook_destinations WHERE tenant_id=$1 AND destination_id=$2`,
        [auth.tenant_id, destinationId],
      );
      if (!current.rows[0]) {
        result(response, 404, requestId, { error: { code: "destination_not_found" } });
        return true;
      }
      const name = displayName(input.display_name);
      const status = String(input.status ?? "active");
      if (!['active', 'disabled'].includes(status)) throw new Error("通知目标状态不正确");
      const endpointText = String(input.endpoint ?? "").trim();
      const endpoint = endpointText ? validateWebhookEndpoint(current.rows[0].provider, endpointText) : undefined;
      const signingSecret = String(input.signing_secret ?? "").trim();
      if (signingSecret && (current.rows[0].provider !== "custom" || signingSecret.length < 16 || signingSecret.length > 256)) {
        throw new Error("自定义 Webhook 签名密钥长度必须为 16-256 个字符");
      }
      const updated = await pool.query(
        `UPDATE notification_webhook_destinations SET display_name=$3,status=$4,
             endpoint_ciphertext=COALESCE($5,endpoint_ciphertext),endpoint_host=COALESCE($6,endpoint_host),
             signing_secret_ciphertext=CASE WHEN $7 THEN NULL ELSE COALESCE($8,signing_secret_ciphertext) END,
             updated_by=$9,updated_at=NOW()
           WHERE tenant_id=$1 AND destination_id=$2
         RETURNING destination_id,provider,display_name,endpoint_host,status,last_tested_at,last_test_status,updated_at`,
        [auth.tenant_id, destinationId, name, status, endpoint ? encryptWebhookSecret(endpoint.toString()) : null,
         endpoint?.hostname ?? null, input.clear_signing_secret === true,
         signingSecret ? encryptWebhookSecret(signingSecret) : null, auth.platform_user_id],
      );
      await audit(auth, requestId, "notification_destination.updated", destinationId, {
        display_name: name, status, endpoint_host: updated.rows[0].endpoint_host,
      });
      result(response, 200, requestId, { data: updated.rows[0] });
    } catch (error: any) {
      result(response, error?.code === "23505" ? 409 : 400, requestId, { error: {
        code: error?.code === "23505" ? "destination_name_conflict" : "invalid_notification_destination",
        message: error instanceof Error ? error.message : "通知目标不正确",
      } });
    }
    return true;
  }
  if (request.method === "DELETE" && !match[2]) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ provider: WebhookProvider; display_name: string; endpoint_host: string; status: string }>(
        `SELECT provider,display_name,endpoint_host,status FROM notification_webhook_destinations
          WHERE tenant_id=$1 AND destination_id=$2 FOR UPDATE`,
        [auth.tenant_id, destinationId]
      );
      const destination = current.rows[0];
      if (!destination) {
        await client.query("ROLLBACK");
        result(response, 404, requestId, { error: { code: "destination_not_found", message: "通知目标不存在" } });
        return true;
      }
      if (destination.status !== "disabled") {
        await client.query("ROLLBACK");
        result(response, 409, requestId, { error: { code: "destination_must_be_disabled", message: "请先停用通知目标，再执行删除" } });
        return true;
      }
      await client.query(`DELETE FROM notification_webhook_destinations WHERE tenant_id=$1 AND destination_id=$2`, [auth.tenant_id, destinationId]);
      await client.query(
        `INSERT INTO audit_logs
          (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
         VALUES ($1,$2,$3,'notification_destination.deleted','notification_webhook_destination',$4,$5,$6)`,
        [auth.tenant_id, auth.auth_kind, auth.actor_id, destinationId, {
          provider: destination.provider, display_name: destination.display_name,
          endpoint_host: destination.endpoint_host, previous_status: destination.status
        }, requestId]
      );
      await client.query("COMMIT");
      result(response, 200, requestId, { data: { destination_id: destinationId, deleted: true } });
    } catch {
      await client.query("ROLLBACK");
      result(response, 500, requestId, { error: { code: "destination_delete_failed", message: "删除通知目标失败" } });
    } finally { client.release(); }
    return true;
  }

  result(response, 405, requestId, { error: { code: "method_not_allowed" } });
  return true;
}
