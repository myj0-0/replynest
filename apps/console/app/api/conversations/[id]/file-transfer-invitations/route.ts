import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { gatewayUrl, hasValidOrigin, sessionToken } from "../../../../../lib/console-session";

const UUID = /^[0-9a-f-]{36}$/i;
function json(body: unknown, status: number) { return NextResponse.json(body, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } }); }

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!hasValidOrigin(request)) return json({ error: { code: "invalid_origin" } }, 403);
  const { id } = await context.params; if (!UUID.test(id)) return json({ error: { code: "conversation_not_found" } }, 404);
  const token = await sessionToken(); if (!token) return json({ error: { code: "session_expired" } }, 401);
  try {
    const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/conversations/${encodeURIComponent(id)}/file-transfer-invitations`), { method: "POST", headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    return json(await upstream.json(), upstream.status);
  } catch { return json({ error: { code: "file_transfer_backend_unavailable", message: "上传邀请服务暂不可用" } }, 503); }
}
