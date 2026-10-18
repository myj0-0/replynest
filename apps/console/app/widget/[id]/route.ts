import { gatewayUrl } from "../../../lib/console-session";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("/* Widget not found */", { status: 404 });
  try {
    const upstream = await fetch(gatewayUrl(`/api/v1/public/web-chat/${id}/loader`), { cache: "no-store", signal: AbortSignal.timeout(10000) });
    return new Response(upstream.ok ? await upstream.text() : "/* Widget not available */", { status: upstream.status, headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "cross-origin" } });
  } catch { return new Response("/* Temporarily unavailable */", { status: 503, headers: { "content-type": "application/javascript" } }); }
}
