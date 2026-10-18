import { createConnection } from "node:net";
import pg from "pg";

export type ComponentStatus = "operational" | "degraded" | "major_outage";
export type ComponentResult = {
  id: string;
  name: string;
  status: ComponentStatus;
  latency_ms: number;
  checked_at?:string|null;
  reason?:string;
};
export type PublicStatus = {
  schema_version: 1;
  status: ComponentStatus;
  checked_at: string;
  components: ComponentResult[];
};

type ProbeResult={status:ComponentStatus;latency_ms:number;checked_at:string|null;reason:string};
type Check = { id: string; name: string; critical: boolean; run: () => Promise<ComponentStatus | void | ProbeResult> };
async function aiCheck(kind:string):Promise<ProbeResult>{
 const base=(process.env.STATUS_GATEWAY_URL??'http://channel-gateway:3001/health').replace(/\/health$/,'');
 const r=await fetch(`${base}/health/ai/${kind}`,{signal:AbortSignal.timeout(3000)}),data=await r.json() as ProbeResult;
 if(!['operational','degraded','major_outage'].includes(data.status??'')||!Number.isFinite(data.latency_ms))throw Error('invalid_probe');return data;
}

export function summarize(components: Array<ComponentResult & { critical?: boolean }>): ComponentStatus {
  if (components.some(item => item.status === "major_outage" && item.critical)) return "major_outage";
  if (components.some(item => item.status !== "operational")) return "degraded";
  return "operational";
}

async function httpCheck(url: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000), redirect: "manual" });
  if (response.status < 200 || response.status >= 400) throw new Error("unavailable");
}

async function wechatCheck(url: string): Promise<ComponentStatus> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000), redirect: "manual" });
  if (response.ok) return "operational";
  const body = await response.json().catch(() => undefined) as { status?: string; live_send_enabled?: boolean } | undefined;
  if (response.status === 503 && body?.status === "configured" && body.live_send_enabled === false) return "degraded";
  throw new Error("unavailable");
}

async function tcpCheck(host: string, port: number, payload?: string, expected?: RegExp): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    let response = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, 3_000);
    const finish = (error?: Error) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(); };
    socket.once("error", error => finish(error));
    socket.once("connect", () => {
      if (!payload) return finish();
      socket.write(payload);
    });
    socket.on("data", chunk => {
      response += chunk.toString("utf8");
      if (!expected || expected.test(response)) finish();
      else if (response.length > 4096) finish(new Error("unexpected response"));
    });
  });
}

function redisCommand(...args: string[]): string {
  return `*${args.length}\r\n${args.map(value => `$${Buffer.byteLength(value)}\r\n${value}\r\n`).join("")}`;
}

async function sidekiqCheck(): Promise<void> {
  const password = process.env.REDIS_PASSWORD ?? "";
  const auth = password ? redisCommand("AUTH", password) : "";
  const payload = `${auth}${redisCommand("SCARD", "processes")}`;
  const count = await new Promise<number>((resolve, reject) => {
    const socket = createConnection({ host: process.env.REDIS_HOST ?? "redis", port: Number(process.env.REDIS_PORT ?? 6379) });
    let response = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, 3_000);
    socket.once("error", error => { clearTimeout(timer); socket.destroy(); reject(error); });
    socket.once("connect", () => socket.write(payload));
    socket.on("data", chunk => {
      response += chunk.toString("utf8");
      const matches = [...response.matchAll(/:(\d+)\r\n/g)];
      if (matches.length) { clearTimeout(timer); socket.destroy(); resolve(Number(matches.at(-1)![1])); }
    });
  });
  if (count < 1) throw new Error("no workers");
}

async function postgresCheck(): Promise<void> {
  const client = new pg.Client({
    host: process.env.POSTGRES_HOST,
    port: 5432,
    database: process.env.POSTGRES_DATABASE,
    user: process.env.POSTGRES_USERNAME,
    password: process.env.POSTGRES_PASSWORD,
    connectionTimeoutMillis: 3_000
  });
  try { await client.connect(); await client.query("SELECT 1"); }
  finally { await client.end().catch(() => undefined); }
}

function checks(): Check[] {
  return [
    {id:'ai_text',name:'AI 文本模型（5 分钟探测）',critical:false,run:()=>aiCheck('text')},
    {id:'ai_embedding',name:'AI 向量模型（5 分钟探测）',critical:false,run:()=>aiCheck('embedding')},
    { id: "console", name: "运营控制台", critical: true, run: () => httpCheck(process.env.STATUS_CONSOLE_URL ?? "http://console:3200/api/health") },
    { id: "gateway", name: "消息接入与业务 API", critical: true, run: () => httpCheck(process.env.STATUS_GATEWAY_URL ?? "http://channel-gateway:3001/health") },
    { id: "chatwoot", name: "客服工作台", critical: true, run: () => httpCheck(process.env.STATUS_CHATWOOT_URL ?? "http://rails:3000/api") },
    { id: "knowledge", name: "AI 知识处理", critical: false, run: () => httpCheck(process.env.STATUS_KNOWLEDGE_URL ?? "http://knowledge-worker:3002/health") },
    { id: "wechat", name: "微信公众号接入", critical: false, run: () => wechatCheck(process.env.STATUS_WECHAT_URL ?? "http://mock-wechat:3100/health") },
    { id: "database", name: "数据存储", critical: true, run: postgresCheck },
    { id: "background_jobs", name: "后台任务", critical: false, run: sidekiqCheck },
    { id: "mail", name: "邮件通知", critical: false, run: () => httpCheck(process.env.STATUS_MAIL_URL ?? "http://mailpit:8025/livez") },
    { id: "file_security", name: "文件安全扫描", critical: false, run: () => tcpCheck(process.env.CLAMAV_HOST ?? "clamav", Number(process.env.CLAMAV_PORT ?? 3310), "PING\n", /PONG/) }
  ];
}

export async function collectStatus(): Promise<PublicStatus> {
  const configured = checks();
  const withCritical = await Promise.all(configured.map(async check => {
    const started = performance.now();
    try {
      const status = await check.run();
      if(status&&typeof status==='object')return {id:check.id,name:check.name,...status,critical:check.critical};
      return { id: check.id, name: check.name, status: status ?? "operational", latency_ms: Math.round(performance.now() - started), critical: check.critical };
    } catch {
      return { id: check.id, name: check.name, status: "major_outage" as const, latency_ms: Math.round(performance.now() - started), critical: check.critical };
    }
  }));
  return {
    schema_version: 1,
    status: summarize(withCritical),
    checked_at: new Date().toISOString(),
    components: withCritical.map(({ critical: _critical, ...component }) => component)
  };
}
