import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "./database.js";
import { readBody, sendJson } from "./shared.js";
import { validateDashboardContextInput } from "./copilot-context.js";

type CopilotAuth = {
  tenant_id: string;
  platform_user_id: string | null;
  actor_id: string;
  auth_kind: "api_key" | "console_session";
};

function reply(response: ServerResponse, status: number, requestId: string, body: Record<string, unknown>) {
  sendJson(response, status, { request_id: requestId, ...body });
}

export async function handleCopilotContextApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  auth: CopilotAuth,
  requestId: string
): Promise<boolean> {
  if (request.method !== "POST" || url.pathname !== "/api/v1/copilot/context") return false;
  if (auth.auth_kind !== "console_session" || !auth.platform_user_id) {
    reply(response, 403, requestId, { error: { code: "console_session_required", message: "Copilot 仅接受已登录的运营控制台会话" } });
    return true;
  }
  const parsed = validateDashboardContextInput(JSON.parse((await readBody(request)).toString("utf8")));
  if ("error" in parsed) {
    reply(response, 400, requestId, { error: { code: parsed.error, message: "Chatwoot 会话上下文不完整" } });
    return true;
  }

  const membership = await pool.query<{ chatwoot_user_email: string; chatwoot_account_id: string }>(
    `SELECT m.chatwoot_user_email,m.chatwoot_account_id
       FROM tenant_memberships m JOIN tenants t ON t.tenant_id=m.tenant_id
      WHERE m.tenant_id=$1 AND m.platform_user_id=$2 AND m.status='active'
        AND t.status IN ('active','test') AND m.chatwoot_account_id=t.chatwoot_account_id`,
    [auth.tenant_id, auth.platform_user_id]
  );
  const mapped = membership.rows[0];
  if (!mapped || mapped.chatwoot_user_email.toLowerCase() !== parsed.agentEmail || String(mapped.chatwoot_account_id) !== parsed.accountId) {
    reply(response, 403, requestId, { error: { code: "chatwoot_agent_mismatch", message: "当前 Chatwoot 成员与运营控制台会话不匹配" } });
    return true;
  }

  const identity = await pool.query<{ customer_id: string; channel: string }>(
    `SELECT customer_id,channel FROM channel_identities
      WHERE tenant_id=$1 AND chatwoot_conversation_id=$2`,
    [auth.tenant_id, parsed.conversationId]
  );
  if (!identity.rows[0]?.customer_id) {
    reply(response, 404, requestId, { error: { code: "conversation_not_mapped", message: "该会话不属于当前企业或尚未建立客户映射" } });
    return true;
  }

  await pool.query(
    `INSERT INTO audit_logs
      (tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
     VALUES ($1,'platform_user',$2,'copilot.context_resolved','chatwoot_conversation',$3,
             jsonb_build_object('channel',$4::text),$5)`,
    [auth.tenant_id, auth.platform_user_id, parsed.conversationId, identity.rows[0].channel, requestId]
  );
  reply(response, 200, requestId, {
    data: {
      customer_id: identity.rows[0].customer_id,
      conversation_id: parsed.conversationId,
      channel: identity.rows[0].channel
    }
  });
  return true;
}
