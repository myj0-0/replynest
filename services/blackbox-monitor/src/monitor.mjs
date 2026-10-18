import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import tls from "node:tls";
import { randomUUID } from "node:crypto";
import { parseFaultInjection, shouldSendFailureAlert } from "./fault-injection.mjs";
import { recordAvailability } from "./availability.mjs";
import { modelProbeResult } from "./model-probe.mjs";
import { automationProbeResult } from './automation-probe.mjs';
import {fetchAutomationDiagnostic,recordAutomationDiagnostic} from './automation-diagnostics.mjs';
import { deliverWebhook, loadMonitorConfig } from "./runtime-config.mjs";

const intervalMs = positiveNumber("CHECK_INTERVAL_MS", 60_000);
const tlsWarningDays = positiveNumber("TLS_WARNING_DAYS", 14);
const stateFile = process.env.STATE_FILE ?? "/data/state.json";
const faultInjectionFile = process.env.FAULT_INJECTION_FILE ?? "/control/fault-injection.json";
const runtimeConfigFile = process.env.RUNTIME_CONFIG_FILE ?? "/control/runtime-config.json";

const targets = [
  { id:'automation',name:'自动化调度与数据库压力',url:'https://api.replynest.cn/health/automation',automation:true },
  { id: "ai_text", name: "AI 文本模型", url: "https://api.replynest.cn/health/ai/text", model: true },
  { id: "ai_embedding", name: "AI 向量检索模型", url: "https://api.replynest.cn/health/ai/embedding", model: true },
  { id: "console", name: "运营控制台", url: "https://console.replynest.cn/api/health" },
  { id: "gateway", name: "业务与消息网关", url: "https://api.replynest.cn/health" },
  { id: "wechat_callback", name: "微信公众号回调入口", url: "https://api.replynest.cn/health/wechat" },
  { id: "inbound_queue", name: "入站消息队列", url: "https://api.replynest.cn/health/inbound" },
  { id: "payment_projection", name: "支付账务投影", url: "https://api.replynest.cn/health/payments" },
  { id: "chatwoot", name: "客服工作台", url: "https://chat.replynest.cn/api" },
  { id: "website", name: "答巢公网入口", url: "https://replynest.cn" }
];

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

async function loadState() {
  try {
    return normalizeState(JSON.parse(await readFile(stateFile, "utf8")));
  } catch {
    return normalizeState({});
  }
}

function normalizeState(state) {
  state.targets ??= {};
  state.tls ??= {};
  state.events ??= [];
  state.alert_delivery ??= { status: "unknown", last_attempt_at: 0, last_success_at: 0, last_error: null };
  state.alert_destinations ??= {};
  if (Number(state.schema_version ?? 0) < 3) {
    // V2 counted every transient probe miss as downtime. Preserve that signal
    // for diagnostics, while public availability starts with the same
    // sustained-failure semantics used by incident alerting.
    state.raw_availability = state.raw_availability ?? state.availability ?? {};
    state.availability = {};
  }
  state.raw_availability ??= {};
  state.availability ??= {};
  state.schema_version = 3;
  state.last_cycle_at ??= 0;
  return state;
}

async function saveState(state) {
  await mkdir(dirname(stateFile), { recursive: true });
  const temp = `${stateFile}.tmp`;
  await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
  await rename(temp, stateFile);
}

function appendEvent(state, event) {
  state.events ??= [];
  state.events.push({ at: Date.now(), ...event });
  if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
}

async function deliverAlert(title, lines, state, config) {
  const active = config.destinations.filter(destination => destination.status === "active");
  if (!active.length) {
    state.alert_delivery = { status: "down", last_attempt_at: Date.now(), last_success_at: state.alert_delivery.last_success_at ?? 0, last_error: "no active alert destination" };
    appendEvent(state, { kind: "alert_delivery_failed", title, error: state.alert_delivery.last_error });
    return false;
  }
  const attemptedAt = Date.now();
  const outcomes = await Promise.all(active.map(async destination => {
    try {
      await deliverWebhook(destination, title, lines, config.probe.request_timeout_seconds * 1000);
      state.alert_destinations[destination.destination_id] = { status: "up", last_attempt_at: attemptedAt, last_success_at: attemptedAt, last_error: null };
      return { ok: true, destination };
    } catch (error) {
      const message = (error instanceof Error ? error.message : "unknown").slice(0, 200);
      state.alert_destinations[destination.destination_id] = { status: "down", last_attempt_at: attemptedAt, last_success_at: state.alert_destinations[destination.destination_id]?.last_success_at ?? 0, last_error: message };
      appendEvent(state, { kind: "alert_delivery_failed", title, destination_id: destination.destination_id, error: message });
      return { ok: false, destination, message };
    }
  }));
  const successes = outcomes.filter(outcome => outcome.ok).length;
  state.alert_delivery.last_attempt_at = attemptedAt;
  state.alert_delivery.status = successes === active.length ? "up" : successes ? "degraded" : "down";
  state.alert_delivery.last_error = outcomes.find(outcome => !outcome.ok)?.message ?? null;
  if (successes) state.alert_delivery.last_success_at = attemptedAt;
  console.log(`alert_delivery title=${JSON.stringify(title)} delivered=${successes}/${active.length}`);
  return successes > 0;
}

async function loadFaultInjection() {
  try {
    return parseFaultInjection(await readFile(faultInjectionFile, "utf8"), new Set(targets.map(target => target.id)));
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("fault_injection_ignored", error instanceof Error ? error.message : "unknown");
    return null;
  }
}

async function checkHttp(target, faultInjection, requestTimeoutMs) {
  if (faultInjection?.target_id === target.id) {
    return {
      ok: false,
      latency_ms: 0,
      error: `controlled fault injection ${faultInjection.drill_id}`,
      drill: true,
      drill_id: faultInjection.drill_id
    };
  }
  const started = performance.now();
  try {
    const response = await fetch(target.url, {
      redirect: "manual",
      headers: { "user-agent": "ReplyNest-Blackbox/0.1" },
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    if(target.automation&&[200,503].includes(response.status)){
      const result=automationProbeResult(await response.json());
      if(!result.ok)result.automation_diagnostic=await fetchAutomationDiagnostic(result,{token:process.env.MONITOR_CONTROL_TOKEN});
      return result;
    }
    if (response.status < 200 || response.status >= 400) throw new Error(`HTTP ${response.status}`);
    if (target.model) return modelProbeResult(await response.json());
    await response.arrayBuffer();
    return { ok: true, latency_ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { ok: false, latency_ms: Math.round(performance.now() - started), error: error instanceof Error ? error.message.slice(0, 160) : "unknown" };
  }
}

async function checkTls(hostname, requestTimeoutMs) {
  return new Promise(resolve => {
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname, rejectUnauthorized: true });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: "timeout" });
    }, requestTimeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timeout);
      const certificate = socket.getPeerCertificate();
      socket.end();
      const expiresAt = Date.parse(certificate.valid_to);
      const daysRemaining = Math.floor((expiresAt - Date.now()) / 86_400_000);
      resolve({ ok: Number.isFinite(expiresAt) && daysRemaining >= tlsWarningDays, days_remaining: daysRemaining });
    });
    socket.once("error", error => {
      clearTimeout(timeout);
      resolve({ ok: false, error: error.message.slice(0, 160) });
    });
  });
}

function stateFor(collection, id) {
  collection[id] ??= { status: "unknown", failures: 0, successes: 0, last_alert_at: 0, incident: null };
  return collection[id];
}

function acknowledged(config, incidentId) {
  return Boolean(incidentId && config.acknowledged_incidents.some(item => item.incident_id === incidentId));
}

async function applyResult(item, result, state, config, componentId, alertTitle) {
  const now = Date.now();
  if (result.ok) {
    item.failures = 0;
    item.successes += 1;
    if (item.status === "down" && item.successes >= config.probe.recovery_threshold) {
      item.status = "up";
      appendEvent(state, { kind: "recovery", component: alertTitle });
      const drillPrefix = item.active_drill_id ? "【演练】" : "";
      const drillLine = item.active_drill_id ? [`演练编号：${item.active_drill_id}`] : [];
      await deliverAlert(`${drillPrefix}${alertTitle}已恢复`, ["状态：连续检查恢复正常", ...drillLine], state, config);
      item.active_drill_id = null;
      item.incident = item.incident ? { ...item.incident, resolved_at: now } : null;
    } else if (item.status === "unknown") {
      item.status = "up";
    }
  } else {
    item.successes = 0;
    item.failures += 1;
    if (item.failures >= config.probe.failure_threshold && (item.status !== "down" || !item.incident?.incident_id)) {
      const newlyDown = item.status !== "down";
      item.status = "down";
      item.incident = { incident_id: randomUUID(), component_id: componentId, component: alertTitle, started_at: now, acknowledged_at: null };
      item.last_alert_at = 0;
      if (newlyDown) appendEvent(state, { kind: "outage", component: alertTitle, error: result.error ?? "TLS 剩余天数不足" });
      if (result.drill) item.active_drill_id = result.drill_id;
    }
    const mayAlert = item.status === "down"
      && !acknowledged(config, item.incident?.incident_id)
      && shouldSendFailureAlert(item.last_alert_at ? "down" : "up", item.last_alert_at, now, config.probe.repeat_alert_seconds * 1000);
    if (mayAlert) {
      const drillPrefix = result.drill ? "【演练】" : "";
      const drillLine = result.drill ? [`演练编号：${result.drill_id}`] : [];
      const repeated = item.last_alert_at ? "（持续故障，等待人工确认）" : "";
      await deliverAlert(`${drillPrefix}${alertTitle}异常${repeated}`, ["状态：连续检查失败", `失败次数：${item.failures}`, `原因：${result.error ?? "TLS 剩余天数不足"}`, `事故编号：${item.incident?.incident_id}`, ...drillLine], state, config);
      item.last_alert_at = now;
    }
  }
  item.last_checked_at = now;
  item.last_result = result;
  state.last_cycle_at = now;
  return item.status !== "down";
}

async function cycle(state) {
  const config = await loadMonitorConfig(runtimeConfigFile);
  const requestTimeoutMs = config.probe.request_timeout_seconds * 1000;
  state.schema_version = 3;
  state.availability ??= {};
  state.raw_availability ??= {};
  const faultInjection = await loadFaultInjection();
  const httpResults = await Promise.all(targets.map(async target => ({ target, result: await checkHttp(target, faultInjection, requestTimeoutMs) })));
  for (const { target, result } of httpResults) {
    if (!result.drill) recordAvailability(state.raw_availability, target.id, result.ok);
    const available = await applyResult(stateFor(state.targets, target.id), result, state, config, target.id, target.name);
    if(target.automation&&!result.drill)recordAutomationDiagnostic(state,result,state.targets[target.id].status);
    if (!result.drill) recordAvailability(state.availability, target.id, available);
  }
  const hostnames = ["replynest.cn", "console.replynest.cn", "api.replynest.cn", "pay.replynest.cn", "chat.replynest.cn", "status.replynest.cn"];
  const tlsResults = await Promise.all(hostnames.map(async hostname => ({ hostname, result: await checkTls(hostname, requestTimeoutMs) })));
  for (const { hostname, result } of tlsResults) {
    recordAvailability(state.raw_availability, "tls", result.ok);
    const available = await applyResult(stateFor(state.tls, hostname), result, state, config, `tls:${hostname}`, `${hostname} TLS`);
    recordAvailability(state.availability, "tls", available);
  }
  await saveState(state);
}

if (process.argv.includes("--test-alert")) {
  const state = await loadState();
  const config = await loadMonitorConfig(runtimeConfigFile);
  const delivered = await deliverAlert("黑盒监控部署测试", ["结果：至少一个告警 Webhook 可用", "说明：这是一条人工触发的测试通知"], state, config);
  await saveState(state);
  if (!delivered) throw new Error(state.alert_delivery.last_error ?? "alert delivery failed");
  console.log("alert_webhook_test=ok");
  process.exit(0);
}

if (process.argv.includes("--once")) {
  const state = await loadState();
  await cycle(state);
  console.log("blackbox_monitor_cycle=ok");
  process.exit(0);
}

let state = await loadState();
if (state.alert_delivery.status === "unknown") {
  const config = await loadMonitorConfig(runtimeConfigFile);
  await deliverAlert("黑盒监控启动自检", ["结果：监控进程已经启动", "说明：此消息仅在告警通道状态未知时发送"], state, config);
  await saveState(state);
}
console.log(`blackbox_monitor_started targets=${targets.length} interval_ms=${intervalMs}`);
while (true) {
  try {
    // A one-off alert test may update the shared state volume while this
    // process is alive. Reload before each cycle so the next probe does not
    // overwrite that newer delivery result with a stale in-memory snapshot.
    state = await loadState();
    await cycle(state);
  } catch (error) {
    console.error("monitor_cycle_error", error instanceof Error ? error.message : "unknown");
  }
  await new Promise(resolve => setTimeout(resolve, intervalMs));
}
