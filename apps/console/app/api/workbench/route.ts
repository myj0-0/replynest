import { NextRequest, NextResponse } from "next/server";
import { consoleUrl, hasValidOrigin, sessionToken } from "../../../lib/console-session";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!hasValidOrigin(request)) {
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }
  const token = await sessionToken();
  if (!token) return NextResponse.redirect(consoleUrl("/login?error=expired"), 303);

  // Compatibility for old forms: never mint another Chatwoot login ticket.
  return NextResponse.redirect(consoleUrl("/workbench"), 303);
}
