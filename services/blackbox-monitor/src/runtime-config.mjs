import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_MONITOR_CONFIG = Object.freeze({
  schema_version: 1,
  probe: {
    request_timeout_seconds: 30,
    failure_threshold: 5,
    recovery_threshold: 2,
    repeat_alert_seconds: 1800
  },
  destinations: [],
  acknowledged_incidents: []
});

const providerHosts = {
  feishu: new Set(["open.feishu.cn", "open.larksuite.com"]),
  wecom: new Set(["qyapi.weixin.qq.com"]),
  dingtalk: new Set(["oapi.dingtalk.com"])
};

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function cleanName(value) {
  const name = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name || name.length > 80) throw new Error("display_name must contain 1-80 characters");
  return name;
}

export function validateDestination(input, existingId) {
  const provider = String(input?.provider ?? "");
  if (!["feishu", "wecom", "dingtalk", "custom"].includes(provider)) throw new Error("unsupported webhook provider");
  const endpoint = new URL(String(input?.endpoint ?? ""));
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) throw new Error("webhook endpoint must be HTTPS");
  const allowed = providerHosts[provider];
  if (allowed && !allowed.has(endpoint.hostname.toLowerCase())) throw new Error(`invalid ${provider} webhook host`);
  if (provider === "custom" && /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$)/i.test(endpoint.hostname)) {
    throw new Error("private webhook endpoints are not allowed");
  }
  const signingSecret = String(input?.signing_secret ?? "").trim();
  if (signingSecret && (provider !== "custom" || signingSecret.length < 16 || signingSecret.length > 256)) {
    throw new Error("custom signing secret must contain 16-256 characters");
  }
  return {
    destination_id: existingId ?? randomUUID(),
    provider,
    display_name: cleanName(input?.display_name),
    endpoint: endpoint.toString(),
    endpoint_host: endpoint.hostname,
    signing_secret: signingSecret || null,
    status: input?.status === "disabled" ? "disabled" : "active",
    created_at: input?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

export function normalizeMonitorConfig(value = {}, env = process.env) {
  const fallback = DEFAULT_MONITOR_CONFIG.probe;
  const destinations = Array.isArray(value.destinations)
    ? value.destinations.flatMap(item => {
        try { return [validateDestination(item, item.destination_id)]; } catch { return []; }
      })
    : [];
  if (!destinations.length && env.FEISHU_WEBHOOK_URL) {
    try {
      destinations.push(validateDestination({ provider: "feishu", display_name: "ReplyNest Feishu", endpoint: env.FEISHU_WEBHOOK_URL }));
    } catch { /* invalid legacy configuration is ignored */ }
  }
  return {
    schema_version: 1,
    probe: {
      request_timeout_seconds: boundedInteger(value.probe?.request_timeout_seconds, fallback.request_timeout_seconds, 3, 120),
      failure_threshold: boundedInteger(value.probe?.failure_threshold, fallback.failure_threshold, 1, 30),
      recovery_threshold: boundedInteger(value.probe?.recovery_threshold, fallback.recovery_threshold, 1, 10),
      repeat_alert_seconds: boundedInteger(value.probe?.repeat_alert_seconds, fallback.repeat_alert_seconds, 60, 86400)
    },
    destinations,
    acknowledged_incidents: Array.isArray(value.acknowledged_incidents)
      ? value.acknowledged_incidents.filter(item => typeof item?.incident_id === "string").slice(-200)
      : []
  };
}

export async function loadMonitorConfig(path, env = process.env) {
  try { return normalizeMonitorConfig(JSON.parse(await readFile(path, "utf8")), env); }
  catch { return normalizeMonitorConfig({}, env); }
}

export async function saveMonitorConfig(path, config) {
  const normalized = normalizeMonitorConfig(config, {});
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  await rename(temp, path);
  return normalized;
}

export function publicMonitorConfig(config) {
  return {
    schema_version: config.schema_version,
    probe: config.probe,
    destinations: config.destinations.map(({ endpoint, signing_secret, ...destination }) => ({
      ...destination,
      endpoint_host: new URL(endpoint).hostname,
      signing_configured: Boolean(signing_secret)
    }))
  };
}

function payloadFor(provider, title, lines) {
  const text = [`【ReplyNest】${title}`, ...lines, `时间：${new Date().toISOString()}`].join("\n");
  if (provider === "feishu") return { msg_type: "text", content: { text } };
  if (provider === "wecom") return { msgtype: "text", text: { content: text } };
  if (provider === "dingtalk") return { msgtype: "text", text: { content: text } };
  return { event: "replynest.status.alert", title, lines, occurred_at: new Date().toISOString() };
}

export async function deliverWebhook(destination, title, lines, timeoutMs) {
  const body = JSON.stringify(payloadFor(destination.provider, title, lines));
  const headers = { "content-type": "application/json", "user-agent": "ReplyNest-Blackbox/0.2" };
  if (destination.provider === "custom" && destination.signing_secret) {
    headers["x-replynest-signature"] = `sha256=${createHmac("sha256", destination.signing_secret).update(body).digest("hex")}`;
  }
  const response = await fetch(destination.endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
  const result = await response.json().catch(() => ({}));
  let accepted = response.ok;
  if (destination.provider === "feishu") accepted &&= result.code === 0 || result.StatusCode === 0 || result.msg === "success";
  if (destination.provider === "wecom") accepted &&= Number(result.errcode ?? 0) === 0;
  if (destination.provider === "dingtalk") accepted &&= Number(result.errcode ?? 0) === 0;
  if (!accepted) throw new Error(`HTTP ${response.status}; code=${result.code ?? result.errcode ?? result.StatusCode ?? "unknown"}`);
  return true;
}
