import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { gatewayUrl, hasValidOrigin, sessionToken } from "../../../../../lib/console-session";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f-]{36}$/i;
const MAX_BYTES = 25 * 1024 * 1024;

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
}

async function contextFor(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return UUID.test(id) ? id : undefined;
}

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const id = await contextFor(context); if (!id) return json({ error: { code: "conversation_not_found" } }, 404);
  const token = await sessionToken(); if (!token) return json({ error: { code: "session_expired" } }, 401);
  try {
    const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/conversations/${encodeURIComponent(id)}/file-transfers`), { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    return json(await upstream.json(), upstream.status);
  } catch { return json({ error: { code: "file_transfer_backend_unavailable" } }, 503); }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!hasValidOrigin(request)) return json({ error: { code: "invalid_origin" } }, 403);
  const id = await contextFor(context); if (!id) return json({ error: { code: "conversation_not_found" } }, 404);
  const token = await sessionToken(); if (!token) return json({ error: { code: "session_expired" } }, 401);
  let form: FormData;
  try { form = await request.formData(); } catch { return json({ error: { code: "invalid_upload", message: "文件上传格式不正确" } }, 400); }
  const file = form.get("file");
  if (!(file instanceof File) || !file.size || file.size > MAX_BYTES) return json({ error: { code: "invalid_upload", message: "请选择不超过 25 MiB 的文件" } }, 400);
  const forwarded = new FormData(); forwarded.set("file", file, file.name);
  try {
    const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/conversations/${encodeURIComponent(id)}/file-transfers`), { method: "POST", headers: { authorization: `Bearer ${token}` }, body: forwarded, cache: "no-store", signal: AbortSignal.timeout(45_000) });
    return json(await upstream.json(), upstream.status);
  } catch { return json({ error: { code: "file_transfer_backend_unavailable", message: "文件处理服务暂不可用" } }, 503); }
}
