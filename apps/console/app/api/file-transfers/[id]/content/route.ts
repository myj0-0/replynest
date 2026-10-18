import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { NextResponse } from "next/server";
import { gatewayUrl, sessionToken } from "../../../../../lib/console-session";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: { code: "file_not_found" } }, { status: 404 });
  const token = await sessionToken(); if (!token) return NextResponse.json({ error: { code: "unauthorized" } }, { status: 401 });
  try {
    const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/file-transfers/${encodeURIComponent(id)}/content`), { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(30_000) });
    const headers = new Headers({ "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    for (const name of ["content-type", "content-length", "content-disposition", "content-security-policy", "x-request-id"]) { const value = upstream.headers.get(name); if (value) headers.set(name, value); }
    return new NextResponse(upstream.body, { status: upstream.status, headers });
  } catch { return NextResponse.json({ error: { code: "file_backend_unavailable" } }, { status: 503 }); }
}
