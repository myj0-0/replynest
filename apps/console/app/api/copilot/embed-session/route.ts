import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { gatewayUrl } from "../../../../lib/console-session";

const chatwootOrigin = () => {
  const configured = process.env.CHATWOOT_PUBLIC_URL;
  return configured ? new URL(configured).origin : "";
};

function corsHeaders(origin: string) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    "cache-control": "no-store",
    vary: "Origin"
  };
}

export async function OPTIONS(request: NextRequest) {
  const expected = chatwootOrigin();
  const origin = request.headers.get("origin") ?? "";
  if (!expected || origin !== expected) return new NextResponse(null, { status: 403 });
  return new NextResponse(null, { status: 204, headers: corsHeaders(expected) });
}

export async function POST(request: NextRequest) {
  const expected = chatwootOrigin();
  const origin = request.headers.get("origin") ?? "";
  if (!expected || origin !== expected) return NextResponse.json({ error: { code: "invalid_origin", message: "请求来源不合法" } }, { status: 403 });
  const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/auth/chatwoot-embed-session"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text(),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  return NextResponse.json(await upstream.json(), { status: upstream.status, headers: corsHeaders(expected) });
}
