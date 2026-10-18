import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ status: "ok", service: "console" }, { headers: { "cache-control": "no-store" } });
}
