import {activityGatewayFetch} from "../../../lib/activity-gateway-fetch";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, sessionToken } from "../../../lib/console-session";

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  const form = await request.formData();
  const tag = String(form.get("tag") ?? "").trim();
  const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/message-campaigns"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": randomUUID() },
    body: JSON.stringify({ name: String(form.get("name") ?? ""), content: String(form.get("content") ?? ""), channel: "wechat_official_account", audience_filter: tag ? { mode: "tags_any", tags: [tag] } : { mode: "all", tags: [] } }),
    cache: "no-store"
  });
  return NextResponse.redirect(consoleUrl(`/operations/outbound?result=${upstream.ok ? "campaign-created" : "campaign-failed"}`), 303);
}
