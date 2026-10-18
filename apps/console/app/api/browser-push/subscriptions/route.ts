import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextRequest, NextResponse } from "next/server";
import { gatewayUrl, hasValidOrigin, sessionToken } from "../../../../lib/console-session";
async function proxy(request: NextRequest, method: "POST" | "DELETE") {
  if (!hasValidOrigin(request)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const token = await sessionToken();
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const path = method === "DELETE" ? "/api/v1/browser-push/subscriptions/current" : "/api/v1/browser-push/subscriptions";
  const response = await activityGatewayFetch(gatewayUrl(path), { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": request.headers.get("user-agent") ?? "" }, body: await request.text(), cache: "no-store" });
  return new NextResponse(await response.text(), { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
export async function POST(request: NextRequest) { return proxy(request, "POST"); }
export async function DELETE(request: NextRequest) { return proxy(request, "DELETE"); }
