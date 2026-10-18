import { NextRequest, NextResponse } from "next/server";
import { gatewayUrl, hasValidOrigin } from "../../../../../lib/console-session";

export const dynamic = "force-dynamic";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BYTES = 25 * 1024 * 1024;
function json(body: unknown, status: number) { return NextResponse.json(body, { status, headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } }); }

export async function GET(_request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params; if (!TOKEN.test(token)) return json({ error: { code: "file_link_not_found" } }, 404);
  try { const upstream = await fetch(gatewayUrl(`/api/v1/public/file-transfers/${token}`), { cache: "no-store", signal: AbortSignal.timeout(10_000) }); return json(await upstream.json(), upstream.status); }
  catch { return json({ error: { code: "file_backend_unavailable" } }, 503); }
}

export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  if (!hasValidOrigin(request)) return json({ error: { code: "invalid_origin" } }, 403);
  const { token } = await context.params; if (!TOKEN.test(token)) return json({ error: { code: "file_link_not_found" } }, 404);
  let form: FormData; try { form = await request.formData(); } catch { return json({ error: { code: "invalid_upload" } }, 400); }
  const file = form.get("file"); if (!(file instanceof File) || !file.size || file.size > MAX_BYTES) return json({ error: { code: "invalid_upload", message: "请选择不超过 25 MiB 的文件" } }, 400);
  const forwarded = new FormData(); forwarded.set("file", file, file.name);
  try { const upstream = await fetch(gatewayUrl(`/api/v1/public/file-transfers/${token}`), { method: "POST", body: forwarded, cache: "no-store", signal: AbortSignal.timeout(45_000) }); return json(await upstream.json(), upstream.status); }
  catch { return json({ error: { code: "file_backend_unavailable", message: "文件处理服务暂不可用" } }, 503); }
}
