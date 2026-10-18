import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { gatewayUrl, hasValidOrigin, sessionToken } from "../../../../lib/console-session";
import { parseQuickReplyMarkdown, parseQuickReplyWorkbook } from "../../../../lib/quick-reply-import";

export const runtime = "nodejs";

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return json({ error: { code: "invalid_origin" } }, 403);
  const token = await sessionToken();
  if (!token) return json({ error: { code: "session_expired" } }, 401);
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size < 1 || file.size > 2 * 1024 * 1024) {
      return json({ error: { code: "invalid_import_file", message: "请选择不超过 2 MiB 的 Excel 或 Markdown 文件" } }, 400);
    }
    const name = file.name.toLowerCase();
    const items = name.endsWith(".md")
      ? parseQuickReplyMarkdown(await file.text())
      : name.endsWith(".xlsx") ? await parseQuickReplyWorkbook(await file.arrayBuffer())
        : undefined;
    if (!items) return json({ error: { code: "unsupported_import_file", message: "仅支持 .xlsx 和 .md 文件" } }, 415);
    const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/quick-replies/import"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ items }),
      cache: "no-store"
    });
    return json(await upstream.json(), upstream.status);
  } catch (error) {
    return json({ error: { code: "invalid_import_file", message: error instanceof Error ? error.message : "无法读取导入文件" } }, 400);
  }
}
