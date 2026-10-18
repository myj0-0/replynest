import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  turbopack: {
    root: path.join(process.cwd(), "../.."),
  },
  async headers() {
    const chatwootOrigin = process.env.CHATWOOT_PUBLIC_URL ?? "http://localhost:3000";
    return [{
      source: "/copilot/:path*",
      headers: [
        { key: "Content-Security-Policy", value: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors ${new URL(chatwootOrigin).origin}` },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        { key: "Cache-Control", value: "no-store" },
      ]
    }];
  },
};

export default nextConfig;
