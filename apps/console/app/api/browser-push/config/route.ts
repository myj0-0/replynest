import {activityGatewayFetch} from "../../../../lib/activity-gateway-fetch";
import { NextResponse } from "next/server";
import { gatewayUrl, sessionToken } from "../../../../lib/console-session";
export async function GET() {
  const token = await sessionToken();
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const response = await activityGatewayFetch(gatewayUrl("/api/v1/browser-push/config"), { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  return new NextResponse(await response.text(), { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
