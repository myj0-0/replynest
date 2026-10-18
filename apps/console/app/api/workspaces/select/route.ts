import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, gatewayUrl, hasValidOrigin, sessionToken } from "../../../../lib/console-session";

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);
  const form = await request.formData();
  const tenantId = String(form.get("tenant_id") ?? "");
  try {
    const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/auth/select-workspace"), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ tenant_id: tenantId }), cache: "no-store", signal: AbortSignal.timeout(5_000) });
    return NextResponse.redirect(consoleUrl(upstream.ok ? "/" : "/workspaces"), 303);
  } catch {
    return NextResponse.redirect(consoleUrl("/workspaces"), 303);
  }
}
