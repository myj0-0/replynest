import { createServer } from "node:http";
import { collectStatus } from "./status-core.js";
import { statusPage } from "./status-page.js";

const port = Number(process.env.STATUS_PORT ?? 3300);
let cached = await collectStatus();
let collecting: Promise<void> | undefined;

async function refresh(): Promise<void> {
  if (collecting) return collecting;
  collecting = collectStatus().then(result => { cached = result; }).finally(() => { collecting = undefined; });
  return collecting;
}

setInterval(() => void refresh(), 15_000).unref();

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const common = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
  if (request.method === "GET" && url.pathname === "/livez") {
    response.writeHead(200, { ...common, "content-type": "application/json; charset=utf-8" });
    return response.end(JSON.stringify({ status: "ok" }));
  }
  if (request.method === "GET" && url.pathname === "/readyz") {
    await refresh();
    response.writeHead(cached.status === "major_outage" ? 503 : 200, { ...common, "content-type": "application/json; charset=utf-8" });
    return response.end(JSON.stringify({ status: cached.status, checked_at: cached.checked_at }));
  }
  if (request.method === "GET" && url.pathname === "/api/v1/status") {
    await refresh();
    response.writeHead(200, { ...common, "access-control-allow-origin": "*", "content-type": "application/json; charset=utf-8" });
    return response.end(JSON.stringify(cached));
  }
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/en" || url.pathname === "/en/")) {
    response.writeHead(200, { ...common, "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:", "content-type": "text/html; charset=utf-8" });
    return response.end(statusPage(url.pathname.startsWith("/en") ? "en" : "zh-CN"));
  }
  response.writeHead(404, { ...common, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "0.0.0.0", () => console.log(`status-service listening on ${port}`));
