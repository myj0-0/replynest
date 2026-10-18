import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { gatewayUrl, hasValidOrigin, sessionToken } from "../../../../lib/console-session";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return mutate(request, params, "DELETE");
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return mutate(request, params, "PATCH");
}

async function mutate(request: NextRequest, params: Promise<{ id: string }>, method: "DELETE" | "PATCH") {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: { code: "invalid_origin" } }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.json({ error: { code: "session_expired" } }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: { code: "quick_reply_not_found" } }, { status: 404 });
  let body: string | undefined;
  if(method === "PATCH") { try { body = JSON.stringify(await request.json()); } catch { return NextResponse.json({error:{code:"invalid_json"}},{status:400}); } }
  const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/quick-replies/${id}`), {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body, cache: "no-store"
  });
  return NextResponse.json(await upstream.json(), { status: upstream.status, headers: { "cache-control": "private, no-store" } });
}
