import { NextResponse } from "next/server";
import { gatewayUrl } from "../../../../../../lib/console-session";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params; if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return NextResponse.json({ error: { code: "file_link_not_found" } }, { status: 404 });
  try {
    const upstream = await fetch(gatewayUrl(`/api/v1/public/file-transfers/${token}/content`), { cache: "no-store", signal: AbortSignal.timeout(30_000) });
    const headers = new Headers({ "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    for (const name of ["content-type", "content-length", "content-disposition", "content-security-policy", "x-request-id"]) { const value = upstream.headers.get(name); if (value) headers.set(name, value); }
    return new NextResponse(upstream.body, { status: upstream.status, headers });
  } catch { return NextResponse.json({ error: { code: "file_backend_unavailable" } }, { status: 503 }); }
}
