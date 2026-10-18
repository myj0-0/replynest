import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./shared.js";

type Auth = { role: "tenant_admin" | "supervisor" | "agent" };

export async function handleCommunicationsApi(request: IncomingMessage, response: ServerResponse, url: URL, auth: Auth, requestId: string): Promise<boolean> {
  if (url.pathname !== "/api/v1/integrations/communications/diagnostics") return false;
  if (request.method !== "GET") { sendJson(response, 405, { request_id: requestId, error: { code: "method_not_allowed" } }); return true; }
  // Platform provider configuration is not a tenant capability, including tenant admins.
  sendJson(response, 403, { request_id: requestId, error: { code: "platform_diagnostics_restricted", message: "此诊断仅供平台运维使用" } });
  return true;
}
