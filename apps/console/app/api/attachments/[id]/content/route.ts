import {activityGatewayFetch} from "../../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { gatewayUrl, sessionToken } from "../../../../../lib/console-session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: { code: "attachment_not_found" } }, { status: 404 });
  const token = await sessionToken();
  if (!token) return NextResponse.json({ error: { code: "unauthorized" } }, { status: 401 });
  const disposition = request.nextUrl.searchParams.get("disposition") === "inline" ? "inline" : "attachment";
  try {
    const upstream = await activityGatewayFetch(gatewayUrl(`/api/v1/attachments/${encodeURIComponent(id)}/content?disposition=${disposition}`), {
      headers: { authorization: `Bearer ${token}`, ...(request.headers.get('range')?{range:request.headers.get('range')!}:{}) }, cache: "no-store", signal: AbortSignal.timeout(20_000)
    });
    const headers = new Headers({ "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    for (const name of ["content-type", "content-length", "content-disposition", "content-security-policy", "x-request-id", "accept-ranges", "content-range"]) {
      const value = upstream.headers.get(name); if (value) headers.set(name, value);
    }
    return new NextResponse(upstream.body, { status: upstream.status, headers });
  } catch {
    return NextResponse.json({ error: { code: "attachment_backend_unavailable" } }, { status: 503 });
  }
}
