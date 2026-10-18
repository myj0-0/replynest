import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, sessionToken } from "../../../../lib/console-session";

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  const response = await activityGatewayFetch(gatewayUrl("/api/v1/growth/trial/claim"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": `console-trial-${randomUUID()}` },
    body: JSON.stringify({ campaign_key: "professional-trial-cn" }), cache: "no-store",
  });
  if (response.ok) return NextResponse.redirect(consoleUrl("/billing?trial=claimed"), 303);
  const body = await response.json().catch(() => ({})) as { error?: { code?: string } };
  return NextResponse.redirect(consoleUrl(`/billing?trial=${encodeURIComponent(body.error?.code ?? "failed")}`), 303);
}
