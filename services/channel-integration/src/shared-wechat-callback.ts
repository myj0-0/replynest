import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "./shared.js";
import { parseOfficialInbound, verifyOfficialCallback, type WeChatConfig } from "./wechat-official.js";
import type { VerifiedSharedEvent } from "./shared-wechat-store.js";
import type { RoutingResult } from "./shared-wechat-routing.js";

export type SharedCallbackConfig = WeChatConfig & { receiverId: string };
export type SharedCallbackDependencies = {
  enabled: boolean;
  handshakeOnly?: boolean;
  config: SharedCallbackConfig;
  record: (event: VerifiedSharedEvent) => Promise<{ duplicate: boolean; decision: RoutingResult }>;
  now?: () => number;
  welcome?: (tenantId:string)=>Promise<string>;
  clearProfile?: (openId:string)=>Promise<void>;
};
const cdata = (value: string) => `<![CDATA[${value.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;

/** Only control-plane replies. Business messages remain held for the isolated dispatcher. */
export function sharedControlText(result: RoutingResult): string | undefined {
  const name = (tenantId: string) => (result.state.associations.find(a => a.tenantId === tenantId)?.name ?? "商家").replace(/[\r\n]/g, " ").slice(0, 80);
  if (result.action === "entered" && result.tenantId) return `当前正在咨询：${name(result.tenantId)}。请发送您的问题。需要更换商家时，请发送“切换商家”。`;
  if (result.action === "choose") {
    const items = result.state.choices?.items ?? [];
    if (!items.length) return "当前没有可咨询的商家，请使用商家提供的网站客服入口。";
    // Bounded response; do not issue a partial list that silently selects a destination.
    const text = "点此进入商家选择页：https://replynest.cn/wechat/merchants\n\n也可回复以下文字指令（10分钟内有效），或只回复代码：\n\n" + items.map(item => `${name(item.tenantId)}\n选择 ${item.code}`).join("\n\n");
    return Buffer.byteLength(text, "utf8") <= 1800 ? text : "关联商家较多，暂无法在公众号中选择，请使用商家提供的网站客服入口。";
  }
  if (result.reason === "no_active_association" || result.reason === "invalid_scene") return "请扫描商家提供的有效专属二维码，或使用网站客服入口。";
  if (result.reason === "invalid_choice") return "选择已失效，请发送“切换商家”重新选择。";
  return undefined;
}

export function encryptSharedReply(content: string, openId: string, config: SharedCallbackConfig, now: number): string {
  const timestamp = String(Math.floor(now / 1000)), nonce = randomBytes(12).toString("hex");
  const xml = Buffer.from(`<xml><ToUserName>${cdata(openId)}</ToUserName><FromUserName>${cdata(config.receiverId)}</FromUserName><CreateTime>${timestamp}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content>${cdata(content)}</Content></xml>`);
  const key = Buffer.from(`${config.encodingAesKey}=`, "base64");
  if (key.length !== 32) throw new Error("invalid_shared_callback_config");
  const header = Buffer.alloc(20); randomBytes(16).copy(header); header.writeUInt32BE(xml.length, 16);
  const plain = Buffer.concat([header, xml, Buffer.from(config.appId)]);
  const padding = 32 - plain.length % 32;
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16)); cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(padding, padding)])), cipher.final()]).toString("base64");
  const signature = createHash("sha1").update([config.token, timestamp, nonce, encrypted].sort().join("")).digest("hex");
  return `<xml><Encrypt>${cdata(encrypted)}</Encrypt><MsgSignature>${cdata(signature)}</MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce>${cdata(nonce)}</Nonce></xml>`;
}

/** Separate callback: no tenant ID accepted from URL/body and no legacy queue fallback.
 * Safe mode is mandatory: plain-mode signatures do not authenticate message bodies.
 */
export async function handleSharedWechatCallback(req: IncomingMessage, res: ServerResponse, url: URL, deps: SharedCallbackDependencies): Promise<boolean> {
  if (url.pathname !== "/webhooks/shared-wechat") return false;
  const respond = (status: number, body: string, xml = false) => {
    res.writeHead(status, { "content-type": `${xml ? "application/xml" : "text/plain"}; charset=utf-8`, "cache-control": "no-store" }); res.end(body);
    return true;
  };
  if (!deps.enabled) return respond(404, "not found");
  if (req.method !== "GET" && req.method !== "POST") return respond(405, "method not allowed");
  const config = deps.config, now = (deps.now ?? Date.now)();
  if (!config.appId || !config.token || !config.receiverId || !/^[A-Za-z0-9+/]{43}$/.test(config.encodingAesKey ?? "")) return respond(503, "unavailable");
  // Do not allow candidate credentials on this dedicated endpoint until reply-key rotation is implemented.
  const active = { appId: config.appId, token: config.token, encodingAesKey: config.encodingAesKey };
  const timestamp = url.searchParams.get("timestamp") ?? "";
  if (!/^\d{10}$/.test(timestamp) || Math.abs(now - Number(timestamp) * 1000) > 10 * 60_000) return respond(403, "invalid callback");
  if (req.method === "GET") {
    // URL ownership checks may use token-based signature + plaintext echostr,
    // independently of the encrypted POST message mode. Verify both GET forms.
    const echo = verifyOfficialCallback(url.searchParams, active);
    return respond(echo === undefined ? 403 : 200, echo ?? "invalid callback");
  }
  if (!url.searchParams.get("msg_signature")) return respond(403, "invalid callback");
  if (deps.handshakeOnly) return respond(503, "shared channel not activated");
  let input: VerifiedSharedEvent;
  try {
    const body = await readBody(req);
    if (body.length > 64 * 1024 || !body.toString("utf8").includes("<Encrypt>")) return respond(400, "invalid callback");
    const parsed = parseOfficialInbound(body, url.searchParams, active);
    if (parsed.raw.ToUserName !== config.receiverId) return respond(403, "invalid callback");
    const occurredAt = Date.parse(parsed.occurred_at ?? "");
    if (!Number.isFinite(occurredAt) || Math.abs(now - occurredAt) > 10 * 60_000) return respond(400, "invalid callback");
    const type = parsed.raw.MsgType, event = parsed.raw.Event;
    const serviceClick=type==='event'&&event==='CLICK'&&['RN_LEGACY_SERVICE','RN_SERVICE_INTRO'].includes(parsed.raw.EventKey);
    if(type==='event' && ['user_authorization_revoke','user_authorization_cancellation','user_info_modified'].includes(event)) {
      if(parsed.raw.AppID!==config.appId||!parsed.raw.OpenID) return respond(403,'invalid callback');
      try {await deps.clearProfile?.(parsed.raw.OpenID);}catch{return respond(503,'temporarily unavailable');}
      return respond(200,'success');
    }
    if (type !== "text" && !parsed.media && !serviceClick && !(type === "event" && ["subscribe", "SCAN", "unsubscribe"].includes(event))) return respond(200, "success");
    if (type === "text" && !/^\d{1,40}$/.test(parsed.raw.MsgId)) return respond(400, "invalid callback");
    input = { appId: config.appId, openId: parsed.user_id, eventId: parsed.event_id, occurredAt,
      kind: serviceClick ? 'service' : parsed.media ? 'media' : type === "text" ? "text" : event === "unsubscribe" ? "unsubscribe" : "scan",
      ...(parsed.media?{text:parsed.text,media:parsed.media}:type === "text" ? { text: parsed.text } : { event, eventKey: parsed.raw.EventKey }) };
  } catch { return respond(403, "invalid callback"); }
  try {
    const { decision } = await deps.record(input);
    if(input.kind==='unsubscribe')await deps.clearProfile?.(input.openId);
    const welcomeTenant=decision.scannedTenantId ?? (['entered','info'].includes(decision.action)?decision.tenantId:undefined);
    let text = welcomeTenant && deps.welcome ? `${await deps.welcome(welcomeTenant)}\n${['entered','info'].includes(decision.action)?'请直接发送文字、图片、视频或语音描述您的问题，客服将在这里回复您。':'您已关联多个商家，请点击上方链接选择当前咨询商家。'}` : sharedControlText(decision);
    if(input.kind==='media'&&decision.action==='choose'&&text)text+='\n\n选择商家后，请重新发送刚才的图片、视频或语音。';
    return text ? respond(200, encryptSharedReply(text, input.openId, config, now), true) : respond(200, "success");
  } catch {
    // Persistence failures must be retried by the provider, never acknowledged as delivered.
    return respond(503, "temporarily unavailable");
  }
}
