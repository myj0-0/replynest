import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { gatewayUrl, hasValidOrigin, sessionToken } from "../../../../../lib/console-session";

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "cache-control": "private, no-store" } });
async function proxy(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (request.method === "PATCH" && !hasValidOrigin(request)) return json({ error: { code: "invalid_origin" } }, 403);
  const token = await sessionToken();
  if (!token) return json({ error: { code: "session_expired" } }, 401);
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({}, 404);
  try {
    const body = request.method === "PATCH" ? await request.text() : undefined;
    if (body && body.length > 30000) return json({}, 413);
    const result = await activityGatewayFetch(gatewayUrl(`/api/v1/conversations/${id}/customer-profile`), {
      method: request.method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body, cache: "no-store", signal: AbortSignal.timeout(15000)
    });
    return json(await result.json(), result.status);
  } catch { return json({ error: { code: "customer_profile_unavailable" } }, 503); }
}
export const GET = proxy;
export const PATCH = proxy;
