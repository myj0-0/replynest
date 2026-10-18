import { Resolver } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';

export function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a,b,c] = address.split('.').map(Number);
  return a > 0 && a < 224 && a !== 10 && a !== 127 &&
    !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0,2,168].includes(b)) &&
    !(a === 198 && [18,19,51].includes(b)) && !(a === 203 && b === 0 && c === 113);
}

export type PublicWebhookDependencies = {
  resolve4?: (hostname: string) => Promise<string[]>;
  request?: typeof https.request;
};
const MAX_RESPONSE = 16 * 1024;
const MAX_REQUEST = 64 * 1024;
let active = 0;

async function resolvePublic(host: string, injected?: PublicWebhookDependencies['resolve4']) {
  // IPv4-only egress intentionally avoids mapped IPv6, NAT64 and transition ranges.
  if (isIP(host)) return publicIpv4(host) ? [host] : [];
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      injected ? injected(host) : resolver.resolve4(host),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        resolver.cancel(); reject(new Error('webhook_dns_timeout'));
      }, 3000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Fixed verified IP, normal TLS hostname verification, no proxy/redirect/agent reuse. */
export async function postPublicWebhook(url: URL, body: string, headers: Record<string,string>,
  readResponse = true, dependencies: PublicWebhookDependencies = {}): Promise<string> {
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (url.port && url.port !== '443') || url.hostname.includes(':')) throw new Error('webhook_invalid_endpoint');
  if (Buffer.byteLength(body) > MAX_REQUEST) throw new Error('webhook_request_too_large');
  if (active >= 8) throw new Error('webhook_capacity_exceeded');
  active++;
  try {
    const addresses = await resolvePublic(url.hostname, dependencies.resolve4);
    if (!addresses.length || addresses.some(ip => !publicIpv4(ip))) throw new Error('webhook_non_public_host');
    return await new Promise<string>((resolve, reject) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (error?: Error, text = '') => {
        if (done) return; done = true; if (timer) clearTimeout(timer);
        error ? reject(error) : resolve(text);
      };
      const req = (dependencies.request ?? https.request)(url, {
        method: 'POST', family: 4, agent: false, maxHeaderSize: 8192, rejectUnauthorized: true,
        // Node versions may request all:true; both branches remain pinned.
        lookup: ((_host: string, options: {all?: boolean}, cb: (...args: any[]) => void) => {
          options?.all ? cb(null, [{address: addresses[0], family: 4}]) : cb(null, addresses[0], 4);
        }) as never,
        headers: {...headers, 'content-length': String(Buffer.byteLength(body)), 'accept-encoding': 'identity'},
      }, response => {
        // Even early-discarded custom/redirect responses can emit stream errors.
        response.on('error', () => finish(new Error('webhook_response_failed')));
        response.on('aborted', () => finish(new Error('webhook_response_aborted')));
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          finish(new Error(`webhook_http_${status}`)); response.destroy(); return;
        }
        if (!readResponse) { finish(); response.destroy(); return; }
        if ((response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') ||
            Number(response.headers['content-length'] ?? 0) > MAX_RESPONSE) {
          finish(new Error('webhook_response_limit')); response.destroy(); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE) { finish(new Error('webhook_response_limit')); response.destroy(); }
          else chunks.push(chunk);
        });
        response.on('end', () => finish(undefined, Buffer.concat(chunks).toString('utf8')));
        response.on('close', () => { if (!done) finish(new Error('webhook_response_closed')); });
      });
      timer = setTimeout(() => { finish(new Error('webhook_timeout')); req.destroy(); }, 10_000);
      req.on('error', () => finish(new Error('webhook_transport_failed')));
      req.on('close', () => { if (!done) finish(new Error('webhook_connection_closed')); });
      req.end(body);
    });
  } finally { active--; }
}
