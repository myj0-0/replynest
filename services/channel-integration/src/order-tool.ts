import { randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { orderProvider } from "./order-provider.js";

export type ToolActor = {
  tenantId: string;
  actorId: string;
  role: "tenant_admin" | "supervisor" | "agent";
};

export type GetOrderInput = {
  customerId: string;
  orderId: string;
  idempotencyKey: string;
  requestId: string;
};

export type GetOrderResult = {
  invocation_id: string;
  tool_name: "getOrder";
  tool_version: "1.0";
  status: "succeeded" | "not_found" | "forbidden" | "invalid_input" | "rate_limited" | "timeout" | "failed";
  authorization_scope: "orders:read";
  data_classification: "confidential_business_data";
  queried_at: string;
  data: null | {
    order_id: string;
    customer_id: string;
    status: string;
    amount: { value: string; currency: string };
    product_summary: string;
    product_batch_id: string | null;
    placed_at: string;
    paid_at: string | null;
    fulfilled_at: string | null;
    source_system: string;
  };
  error: null | { code: string; message: string; retryable: boolean };
};

const TOOL_NAME = "getOrder" as const;
const TOOL_VERSION = "1.0" as const;
const SCOPE = "orders:read" as const;
const CLASSIFICATION = "confidential_business_data" as const;

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validOrderId(value: string): boolean {
  return /^[A-Z0-9][A-Z0-9_-]{5,63}$/i.test(value);
}

function errorResult(
  status: Exclude<GetOrderResult["status"], "succeeded">,
  code: string,
  message: string,
  retryable: boolean,
  invocationId = randomUUID()
): GetOrderResult {
  return {
    invocation_id: invocationId,
    tool_name: TOOL_NAME,
    tool_version: TOOL_VERSION,
    status,
    authorization_scope: SCOPE,
    data_classification: CLASSIFICATION,
    queried_at: new Date().toISOString(),
    data: null,
    error: { code, message, retryable }
  };
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

async function persistStandaloneResult(actor: ToolActor, input: GetOrderInput, result: GetOrderResult, durationMs: number) {
  if (!validUuid(input.requestId)) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO tool_invocations
        (invocation_id,tenant_id,tool_name,tool_version,actor_type,actor_id,customer_id,idempotency_key,
         authorization_scope,data_classification,input_data,output_data,status,duration_ms)
       VALUES ($1,$2,$3,$4,'tenant_api_key',$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (tenant_id,tool_name,idempotency_key) DO NOTHING RETURNING invocation_id`,
      [result.invocation_id, actor.tenantId, TOOL_NAME, TOOL_VERSION, actor.actorId,
       validUuid(input.customerId) ? input.customerId : null, input.idempotencyKey || `invalid-${result.invocation_id}`,
       SCOPE, CLASSIFICATION, { order_id: input.orderId, customer_id: input.customerId }, result, result.status, durationMs]
    );
    if (inserted.rows[0]) {
      await client.query(
        `INSERT INTO audit_logs
          (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
         VALUES ($1,'tenant_api_key',$2,'tool.get_order.queried','tool_invocation',$3,
                 jsonb_build_object('tool_name',$4::text,'status',$5::text,'order_id',$6::text,'customer_id',$7::text),$8)`,
        [actor.tenantId, actor.actorId, result.invocation_id, TOOL_NAME, result.status, input.orderId, input.customerId, input.requestId]
      );
    }
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

export async function invokeGetOrder(actor: ToolActor, input: GetOrderInput): Promise<GetOrderResult> {
  const started = Date.now();
  if (!validUuid(input.customerId) || !validOrderId(input.orderId) || !input.idempotencyKey || input.idempotencyKey.length > 180) {
    const result = errorResult("invalid_input", "invalid_tool_input", "订单号或客户标识不合法", false);
    await persistStandaloneResult(actor, input, result, Date.now() - started);
    return result;
  }
  if (!validUuid(input.requestId)) return errorResult("invalid_input", "invalid_request_id", "请求标识不合法", false);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
      `${actor.tenantId}:${TOOL_NAME}:${input.idempotencyKey}`
    ]);
    const replay = await client.query<{ output_data: GetOrderResult }>(
      `SELECT output_data FROM tool_invocations WHERE tenant_id=$1 AND tool_name=$2 AND idempotency_key=$3`,
      [actor.tenantId, TOOL_NAME, input.idempotencyKey]
    );
    if (replay.rows[0]) {
      await client.query("COMMIT");
      return replay.rows[0].output_data;
    }
    const recent = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tool_invocations
        WHERE tenant_id=$1 AND actor_id=$2 AND tool_name=$3 AND created_at>NOW()-INTERVAL '1 minute'`,
      [actor.tenantId, actor.actorId, TOOL_NAME]
    );
    let result: GetOrderResult;
    if (Number(recent.rows[0].count) >= 60) {
      result = errorResult("rate_limited", "tool_rate_limited", "订单查询过于频繁，请稍后重试", true);
    } else {
      const order = await orderProvider.getOrder(actor.tenantId, input.customerId, input.orderId, 1500);
      if (!order) {
        result = errorResult("not_found", "order_not_found", "未找到与当前客户匹配的订单", false);
      } else {
        const item = order;
        result = {
          invocation_id: randomUUID(), tool_name: TOOL_NAME, tool_version: TOOL_VERSION, status: "succeeded",
          authorization_scope: SCOPE, data_classification: CLASSIFICATION, queried_at: new Date().toISOString(),
          data: {
            order_id: item.external_order_id, customer_id: item.customer_id, status: item.status,
            amount: { value: money(Number(item.amount_cents)), currency: item.currency },
            product_summary: item.product_summary, product_batch_id: item.product_batch_id,
            placed_at: item.placed_at, paid_at: item.paid_at, fulfilled_at: item.fulfilled_at,
            source_system: item.source_system
          },
          error: null
        };
      }
    }
    await client.query(
      `INSERT INTO tool_invocations
        (invocation_id,tenant_id,tool_name,tool_version,actor_type,actor_id,customer_id,idempotency_key,
         authorization_scope,data_classification,input_data,output_data,status,duration_ms)
       VALUES ($1,$2,$3,$4,'tenant_api_key',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [result.invocation_id, actor.tenantId, TOOL_NAME, TOOL_VERSION, actor.actorId, input.customerId,
       input.idempotencyKey, SCOPE, CLASSIFICATION, { order_id: input.orderId, customer_id: input.customerId },
       result, result.status, Date.now() - started]
    );
    await client.query(
      `INSERT INTO audit_logs
        (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
       VALUES ($1,'tenant_api_key',$2,'tool.get_order.queried','tool_invocation',$3,
               jsonb_build_object('tool_name',$4::text,'status',$5::text,'order_id',$6::text,'customer_id',$7::text),$8)`,
      [actor.tenantId, actor.actorId, result.invocation_id, TOOL_NAME, result.status, input.orderId, input.customerId, input.requestId]
    );
    await client.query("COMMIT");
    return result;
  } catch (error: any) {
    await client.query("ROLLBACK");
    const timeout = error?.code === "57014" || /timeout/i.test(String(error?.message ?? ""));
    const result = errorResult(timeout ? "timeout" : "failed", timeout ? "tool_timeout" : "tool_unavailable",
      timeout ? "订单查询超时，请稍后重试" : "订单服务暂时不可用，请人工核实", true);
    await persistStandaloneResult(actor, input, result, Date.now() - started);
    return result;
  } finally {
    client.release();
  }
}
