import {activityGatewayFetch} from "../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { gatewayUrl, hasValidOrigin, sessionToken } from "../../../lib/console-session";

function json(body: unknown, status: number) { return NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } }); }

export async function GET(request: NextRequest) {
  const token = await sessionToken();
  if (!token) return json({ error: { code: "session_expired" } }, 401);
  const query = request.nextUrl.searchParams.get("query") ?? "";
  const params = new URLSearchParams({ query });
  for (const key of ["mode", "offset"]) { const value = request.nextUrl.searchParams.get(key); if(value !== null) params.set(key,value); }
  const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/quick-replies?${params}`), {
    headers: { authorization: `Bearer ${token}` }, cache: "no-store"
  });
  return json(await upstream.json(), upstream.status);
}

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) return json({ error: { code: "invalid_origin" } }, 403);
  const token = await sessionToken();
  if (!token) return json({ error: { code: "session_expired" } }, 401);
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: { code: "invalid_json" } }, 400); }
  const upstream = await activityGatewayFetch(gatewayUrl("/api/v1/quick-replies"), {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body), cache: "no-store"
  });
  return json(await upstream.json(), upstream.status);
}
