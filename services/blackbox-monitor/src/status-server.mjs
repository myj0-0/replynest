import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { statusPage } from "./status-page.mjs";
import {automationDiagnosticPage} from './automation-diagnostics.mjs';
import { deliverWebhook, loadMonitorConfig, publicMonitorConfig, saveMonitorConfig, validateDestination } from "./runtime-config.mjs";
import {
  availabilitySeries,
  availabilitySummary,
  combinedAvailabilitySeries,
  combinedAvailabilitySummary
} from "./availability.mjs";

const port = Number(process.env.STATUS_PORT ?? 3400);
const stateFile = process.env.STATE_FILE ?? "/data/state.json";
const runtimeConfigFile = process.env.RUNTIME_CONFIG_FILE ?? "/control/runtime-config.json";
const controlToken = process.env.MONITOR_CONTROL_TOKEN ?? "";
const staleAfterMs = Number(process.env.STATUS_STALE_AFTER_MS ?? 180_000);
const logoFile = new URL("../assets/replynest-brand-cn.png", import.meta.url);
const iconFile = new URL("../assets/replynest-mark.png", import.meta.url);
const definitions = [
  {id:'automation',name:'自动化调度与数据库压力',critical:false},
  { id: "ai_text", name: "AI 文本模型（每 5 分钟探测）", critical: false },
  { id: "ai_embedding", name: "AI 向量检索模型（每 5 分钟探测）", critical: false },
  { id: "console", name: "运营控制台", critical: true },
  { id: "gateway", name: "消息接入与业务 API", critical: true },
  { id: "chatwoot", name: "客服工作台", critical: true },
  { id: "wechat_callback", name: "微信公众号接入", critical: false },
  { id: "inbound_queue", name: "入站消息队列", critical: false },
  { id: "payment_projection", name: "支付账务投影", critical: false },
  { id: "website", name: "答巢公网入口", critical: true }
];
const criticalAvailabilityIds = definitions.filter(item => item.critical).map(item => item.id);
const requiredTlsHostnames = [
  "replynest.cn",
  "console.replynest.cn",
  "api.replynest.cn",
  "chat.replynest.cn",
  "pay.replynest.cn",
  "status.replynest.cn"
];

async function publicStatus() {
  let state;
  try {
    state = JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    state = { targets: {}, tls: {}, availability: {}, raw_availability: {}, last_cycle_at: 0 };
  }
  const stale = !Number.isFinite(state.last_cycle_at) || Date.now() - state.last_cycle_at > staleAfterMs;
  const components = definitions.map(definition => {
    const item = state.targets?.[definition.id];
    const status = stale || item?.status === "down"
      ? (definition.critical ? "major_outage" : "degraded")
      : item?.status === "up" ? "operational" : "degraded";
    return {
      id: definition.id,
      name: definition.name,
      status,
      latency_ms: Number(item?.last_result?.latency_ms ?? 0),
      availability_90d: availabilitySummary(state.availability, definition.id),
      availability_daily: availabilitySeries(state.availability, definition.id),
      probe_success_90d: availabilitySummary(state.raw_availability, definition.id)
    };
  });
  const tlsValues = requiredTlsHostnames.map(hostname => state.tls?.[hostname]);
  const tlsDown = tlsValues.some(item => item?.status === "down");
  const tlsReady = tlsValues.every(item => item?.status === "up");
  components.push({
    id: "tls",
    name: "HTTPS 证书与域名",
    status: stale || tlsDown ? "major_outage" : tlsReady ? "operational" : "degraded",
    latency_ms: 0,
    availability_90d: availabilitySummary(state.availability, "tls"),
    availability_daily: availabilitySeries(state.availability, "tls"),
    probe_success_90d: availabilitySummary(state.raw_availability, "tls")
  });
  const status = stale || components.some(item => item.status === "major_outage")
    ? "major_outage"
    : components.some(item => item.status !== "operational") ? "degraded" : "operational";
  return {
    schema_version: 3,
    status,
    checked_at: new Date(state.last_cycle_at || 0).toISOString(),
    availability_90d: combinedAvailabilitySummary(state.availability, criticalAvailabilityIds),
    availability_daily: combinedAvailabilitySeries(state.availability, criticalAvailabilityIds),
    probe_success_90d: combinedAvailabilitySummary(state.raw_availability, criticalAvailabilityIds),
    monitoring: {
      alert_delivery: {
        status: state.alert_delivery?.status ?? "unknown",
        last_attempt_at: state.alert_delivery?.last_attempt_at ? new Date(state.alert_delivery.last_attempt_at).toISOString() : null,
        last_success_at: state.alert_delivery?.last_success_at ? new Date(state.alert_delivery.last_success_at).toISOString() : null,
        last_error: state.alert_delivery?.last_error ?? null
      }
    },
    components
  };
}

async function readState() {
  try { return JSON.parse(await readFile(stateFile, "utf8")); }
  catch { return { targets: {}, tls: {}, events: [], alert_delivery: {}, alert_destinations: {} }; }
}

function activeIncidents(state, config) {
  const acknowledgements = new Map(config.acknowledged_incidents.map(item => [item.incident_id, item]));
  const items = [...Object.values(state.targets ?? {}), ...Object.values(state.tls ?? {})];
  return items.flatMap(item => item?.status === "down" && item.incident ? [{
    ...item.incident,
    failures: item.failures,
    last_error: item.last_result?.error ?? null,
    last_checked_at: item.last_checked_at ?? null,
    acknowledgement: acknowledgements.get(item.incident.incident_id) ?? null
  }] : []);
}

function authorized(request) {
  const header = request.headers.authorization ?? "";
  return controlToken.length >= 32 && header === `Bearer ${controlToken}`;
}

async function readJson(request, maxBytes = 32_768) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_json");
  return value;
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function controlApi(request, response, url) {
  if (!url.pathname.startsWith("/api/v1/control/")) return false;
  if (!authorized(request)) { json(response, 404, { error: { code: "not_found" } }); return true; }
  let config = await loadMonitorConfig(runtimeConfigFile);
  if (request.method === "GET" && url.pathname === "/api/v1/control/monitor") {
    const history=url.searchParams.get('automation_history')==='1';
    const page=Number(url.searchParams.get('page')??1);
    if(history&&(!Number.isInteger(page)||page<1||page>100)){json(response,400,{error:{code:'invalid_page'}});return true;}
    const state = await readState();
    json(response, 200, { data: {
      ...publicMonitorConfig(config),
      incidents: activeIncidents(state, config),
      alert_delivery: state.alert_delivery ?? {},
      destination_delivery: state.alert_destinations ?? {},
      last_cycle_at: state.last_cycle_at ?? null,
      recent_events: (state.events ?? []).slice(-30).reverse(),
      ...(history?{automation_diagnostics:automationDiagnosticPage(state,page)}:{})
    } });
    return true;
  }
  if (request.method === "PATCH" && url.pathname === "/api/v1/control/monitor/config") {
    try {
      const body = await readJson(request);
      config = await saveMonitorConfig(runtimeConfigFile, { ...config, probe: { ...config.probe, ...body } });
      json(response, 200, { data: publicMonitorConfig(config) });
    } catch (error) { json(response, 400, { error: { code: "invalid_monitor_config", message: error instanceof Error ? error.message : "invalid config" } }); }
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/control/monitor/destinations") {
    try {
      const destination = validateDestination(await readJson(request));
      config.destinations.push(destination);
      config = await saveMonitorConfig(runtimeConfigFile, config);
      json(response, 201, { data: publicMonitorConfig(config).destinations.find(item => item.destination_id === destination.destination_id) });
    } catch (error) { json(response, 400, { error: { code: "invalid_destination", message: error instanceof Error ? error.message : "invalid destination" } }); }
    return true;
  }
  const destinationMatch = url.pathname.match(/^\/api\/v1\/control\/monitor\/destinations\/([0-9a-f-]{36})(?:\/(test))?$/i);
  if (destinationMatch) {
    const index = config.destinations.findIndex(item => item.destination_id === destinationMatch[1]);
    if (index < 0) { json(response, 404, { error: { code: "destination_not_found" } }); return true; }
    if (request.method === "POST" && destinationMatch[2] === "test") {
      try {
        await deliverWebhook(config.destinations[index], "状态告警通道测试", ["结果：测试消息发送成功", `目标：${config.destinations[index].display_name}`], config.probe.request_timeout_seconds * 1000);
        json(response, 200, { data: { delivered: true } });
      } catch (error) { json(response, 502, { error: { code: "webhook_test_failed", message: error instanceof Error ? error.message : "delivery failed" } }); }
      return true;
    }
    if (request.method === "PATCH" && !destinationMatch[2]) {
      try {
        const body = await readJson(request);
        const current = config.destinations[index];
        const updated = validateDestination({
          ...current,
          ...body,
          endpoint: body.endpoint || current.endpoint,
          signing_secret: body.clear_signing_secret ? "" : body.signing_secret || current.signing_secret,
          created_at: current.created_at
        }, current.destination_id);
        config.destinations[index] = updated;
        config = await saveMonitorConfig(runtimeConfigFile, config);
        json(response, 200, { data: publicMonitorConfig(config).destinations[index] });
      } catch (error) { json(response, 400, { error: { code: "invalid_destination", message: error instanceof Error ? error.message : "invalid destination" } }); }
      return true;
    }
    if (request.method === "DELETE" && !destinationMatch[2]) {
      if (config.destinations[index].status !== "disabled") { json(response, 409, { error: { code: "destination_must_be_disabled" } }); return true; }
      config.destinations.splice(index, 1);
      await saveMonitorConfig(runtimeConfigFile, config);
      json(response, 200, { data: { deleted: true, destination_id: destinationMatch[1] } });
      return true;
    }
  }
  const incidentMatch = url.pathname.match(/^\/api\/v1\/control\/monitor\/incidents\/([0-9a-f-]{36})\/acknowledge$/i);
  if (incidentMatch && request.method === "POST") {
    const state = await readState();
    const incident = activeIncidents(state, config).find(item => item.incident_id === incidentMatch[1]);
    if (!incident) { json(response, 404, { error: { code: "incident_not_found" } }); return true; }
    const body = await readJson(request).catch(() => ({}));
    if (!config.acknowledged_incidents.some(item => item.incident_id === incident.incident_id)) {
      config.acknowledged_incidents.push({ incident_id: incident.incident_id, acknowledged_at: new Date().toISOString(), acknowledged_by: String(body.acknowledged_by ?? "platform-admin").slice(0, 120) });
      config = await saveMonitorConfig(runtimeConfigFile, config);
    }
    json(response, 200, { data: { incident_id: incident.incident_id, acknowledged: true } });
    return true;
  }
  json(response, 405, { error: { code: "method_not_allowed" } });
  return true;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (await controlApi(request, response, url)) return;
  const readableMethod = request.method === "GET" || request.method === "HEAD";
  const end = body => response.end(request.method === "HEAD" ? undefined : body);
  if (readableMethod && url.pathname === "/livez") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return end(JSON.stringify({ status: "ok", service: "external-status" }));
  }
  if (readableMethod && (url.pathname === "/readyz" || url.pathname === "/api/v1/status")) {
    const body = await publicStatus();
    const stale = Date.now() - Date.parse(body.checked_at) > staleAfterMs;
    response.writeHead(url.pathname === "/readyz" && stale ? 503 : 200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    return end(JSON.stringify(body));
  }
  if (readableMethod && (url.pathname === "/" || url.pathname === "/en" || url.pathname === "/en/")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    return end(statusPage(url.pathname.startsWith("/en") ? "en" : "zh-CN"));
  }
  if (readableMethod && ["/assets/replynest-brand-cn.png", "/assets/replynest-mark.png", "/favicon.ico"].includes(url.pathname)) {
    try {
      const body = await readFile(url.pathname === "/assets/replynest-brand-cn.png" ? logoFile : iconFile);
      response.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400", "content-length": body.length });
      return end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return response.end("not found");
    }
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
});

server.listen(port, "0.0.0.0", () => console.log(`external_status_started port=${port}`));
