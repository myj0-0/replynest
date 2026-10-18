import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { secretValue } from "./secret-value.js";

export function requiredEnv(name: string): string {
  const value = secretValue(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("Request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function signature(secret: string, timestamp: string, nonce: string, rawBody: Buffer): string {
  return createHmac("sha256", secret)
    .update(timestamp)
    .update(".")
    .update(nonce)
    .update(".")
    .update(rawBody)
    .digest("hex");
}

export function verifySignature(secret: string, timestamp: string, nonce: string, rawBody: Buffer, received: string): boolean {
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return false;
  if (!/^[a-f0-9]{64}$/i.test(received)) return false;
  const expected = signature(secret, timestamp, nonce, rawBody);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}

export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${url} returned ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}
