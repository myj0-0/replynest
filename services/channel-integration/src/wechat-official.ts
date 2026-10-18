import { createDecipheriv, createHash } from "node:crypto";
import { secretValue } from "./secret-value.js";
import { WeChatSendRejected } from "./wechat-send-error.js";
import { sceneDigest } from "./shared-wechat-routing.js";
import {massTextPayload,massStatus} from './wechat-mass-core.js';
import {officialMedia,type WeChatMedia} from './wechat-media-core.js';

export type OfficialInboundMessage = {
  event_id: string;
  message_id: string;
  user_id: string;
  user_name?: string;
  text: string;
  occurred_at?: string;
  media?: WeChatMedia;
  raw: Record<string, string>;
};

export type WeChatConfig = {
  appId: string;
  appSecret: string;
  token: string;
  encodingAesKey?: string;
  candidateToken?: string;
  candidateEncodingAesKey?: string;
};

type WeChatCallbackCredential = Pick<WeChatConfig, "token" | "encodingAesKey">;

const cachedAccessTokens = new Map<string, { value: string; expiresAt: number }>();

function sha1(parts: string[]): string {
  return createHash("sha1").update(parts.sort().join(""), "utf8").digest("hex");
}

function safeEqualText(left: string, right: string): boolean {
  if (!/^[a-f0-9]{40}$/i.test(left) || !/^[a-f0-9]{40}$/i.test(right)) return false;
  return left.toLowerCase() === right.toLowerCase();
}

export function verifyOfficialSignature(token: string, timestamp: string, nonce: string, received: string): boolean {
  if (!token || !/^\d{1,12}$/.test(timestamp) || !nonce || !received) return false;
  return safeEqualText(sha1([token, timestamp, nonce]), received);
}

export function verifyOfficialMessageSignature(token: string, timestamp: string, nonce: string, encrypted: string, received: string): boolean {
  if (!token || !/^\d{1,12}$/.test(timestamp) || !nonce || !encrypted || !received) return false;
  return safeEqualText(sha1([token, timestamp, nonce, encrypted]), received);
}

function xmlDecode(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function field(xml: string, name: string): string {
  const match = xml.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${name}>`, "i"));
  return xmlDecode((match?.[1] ?? match?.[2] ?? "").trim());
}

function unpadWechat(buffer: Buffer): Buffer {
  const padding = buffer.at(-1) ?? 0;
  if (padding < 1 || padding > 32 || buffer.length < padding) throw new Error("invalid_wechat_padding");
  for (let index = buffer.length - padding; index < buffer.length; index += 1) {
    if (buffer[index] !== padding) throw new Error("invalid_wechat_padding");
  }
  return buffer.subarray(0, buffer.length - padding);
}

export function decryptOfficialPayload(encrypted: string, encodingAesKey: string, expectedAppId: string): string {
  const key = Buffer.from(`${encodingAesKey}=`, "base64");
  if (key.length !== 32) throw new Error("invalid_wechat_encoding_aes_key");
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plain = unpadWechat(Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]));
  if (plain.length < 20) throw new Error("invalid_wechat_envelope");
  const xmlLength = plain.readUInt32BE(16);
  const xmlEnd = 20 + xmlLength;
  if (xmlEnd > plain.length) throw new Error("invalid_wechat_envelope");
  const receiverId = plain.subarray(xmlEnd).toString("utf8");
  if (receiverId !== expectedAppId) throw new Error("wechat_receiver_mismatch");
  return plain.subarray(20, xmlEnd).toString("utf8");
}

function callbackCredentials(config: Pick<WeChatConfig, "token" | "encodingAesKey" | "candidateToken" | "candidateEncodingAesKey">): WeChatCallbackCredential[] {
  const credentials: WeChatCallbackCredential[] = [{ token: config.token, encodingAesKey: config.encodingAesKey }];
  if (config.candidateToken) credentials.push({ token: config.candidateToken, encodingAesKey: config.candidateEncodingAesKey });
  return credentials;
}

export function verifyOfficialCallback(query: URLSearchParams, config: Pick<WeChatConfig, "appId" | "token" | "encodingAesKey" | "candidateToken" | "candidateEncodingAesKey">): string | undefined {
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  const echo = query.get("echostr") ?? "";
  const messageSignature = query.get("msg_signature") ?? "";
  if (messageSignature) {
    for (const credential of callbackCredentials(config)) {
      if (!credential.encodingAesKey || !verifyOfficialMessageSignature(credential.token, timestamp, nonce, echo, messageSignature)) continue;
      try {
        return decryptOfficialPayload(echo, credential.encodingAesKey, config.appId);
      } catch {
        continue;
      }
    }
    return undefined;
  }
  const signature = query.get("signature") ?? "";
  return callbackCredentials(config).some(credential => verifyOfficialSignature(credential.token, timestamp, nonce, signature)) ? echo : undefined;
}

function normalizedText(values: Record<string, string>): string {
  if (values.MsgType === "text" && values.Content) return values.Content;
  if (values.MsgType === "event") {
    const labels: Record<string, string> = { subscribe: "用户关注了公众号", unsubscribe: "用户取消关注公众号", CLICK: "用户点击了菜单", VIEW: "用户打开了菜单链接" };
    return `[公众号事件] ${labels[values.Event] ?? values.Event ?? "unknown"}`;
  }
  const labels: Record<string, string> = { image: "图片", voice: "语音", video: "视频", shortvideo: "小视频", location: "位置", link: "链接" };
  return `[公众号消息] ${labels[values.MsgType] ?? values.MsgType ?? "unknown"}`;
}

export function parseOfficialInbound(rawBody: Buffer, query: URLSearchParams, config: Pick<WeChatConfig, "appId" | "token" | "encodingAesKey" | "candidateToken" | "candidateEncodingAesKey">): OfficialInboundMessage {
  const outerXml = rawBody.toString("utf8");
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  const encrypted = field(outerXml, "Encrypt");
  let xml = outerXml;
  if (encrypted) {
    const signature = query.get("msg_signature") ?? "";
    let decrypted: string | undefined;
    for (const credential of callbackCredentials(config)) {
      if (!credential.encodingAesKey || !verifyOfficialMessageSignature(credential.token, timestamp, nonce, encrypted, signature)) continue;
      try {
        decrypted = decryptOfficialPayload(encrypted, credential.encodingAesKey, config.appId);
        break;
      } catch {
        continue;
      }
    }
    if (decrypted === undefined) throw new Error("invalid_wechat_signature");
    xml = decrypted;
  } else {
    const signature = query.get("signature") ?? "";
    if (!callbackCredentials(config).some(credential => verifyOfficialSignature(credential.token, timestamp, nonce, signature))) throw new Error("invalid_wechat_signature");
  }
  const names = ["ToUserName", "FromUserName", "CreateTime", "MsgType", "Content", "MsgId", "Event", "EventKey", "MediaId", "Format", "Recognition", "ThumbMediaId", "OpenID", "AppID", "RevokeInfo"];
  const values = Object.fromEntries(names.map(name => [name, field(xml, name)]));
  if (!values.FromUserName || !values.CreateTime || !values.MsgType) throw new Error("invalid_wechat_payload");
  const fallbackId = createHash("sha256").update([values.FromUserName, values.CreateTime, values.MsgType, values.Event, values.EventKey].join(":"), "utf8").digest("hex");
  const messageId = values.MsgId || fallbackId;
  const media=officialMedia(values);
  return {
    event_id: `wechat-${messageId}`,
    message_id: messageId,
    user_id: values.FromUserName,
    user_name: values.FromUserName,
    text: normalizedText(values),
    ...(media?{media}:{}),
    occurred_at: new Date(Number(values.CreateTime) * 1000).toISOString(),
    raw: values
  };
}

export function officialConfigFromEnv(): WeChatConfig {
  return {
    appId: process.env.WECHAT_OFFICIAL_APP_ID ?? "",
    appSecret: secretValue("WECHAT_OFFICIAL_APP_SECRET") ?? "",
    token: secretValue("WECHAT_OFFICIAL_TOKEN") ?? "",
    encodingAesKey: secretValue("WECHAT_OFFICIAL_ENCODING_AES_KEY"),
    candidateToken: secretValue("WECHAT_OFFICIAL_TOKEN_CANDIDATE"),
    candidateEncodingAesKey: secretValue("WECHAT_OFFICIAL_ENCODING_AES_KEY_CANDIDATE")
  };
}

export function officialConfigured(config = officialConfigFromEnv()): boolean {
  return Boolean(config.appId && config.appSecret && config.token);
}

export async function accessToken(config: WeChatConfig, forceRefresh = false): Promise<string> {
  const cacheKey = config.appId;
  const cachedAccessToken = cachedAccessTokens.get(cacheKey);
  if (!forceRefresh && cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 120_000) return cachedAccessToken.value;
  if (forceRefresh) cachedAccessTokens.delete(cacheKey);
  const url = new URL("https://api.weixin.qq.com/cgi-bin/stable_token");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credential", appid: config.appId, secret: config.appSecret, force_refresh: forceRefresh }),
    signal: AbortSignal.timeout(8_000)
  });
  const body = await response.json() as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
  if (!response.ok || !body.access_token) throw new Error(`wechat_token_error:${body.errcode ?? response.status}:${body.errmsg ?? "unknown"}`);
  cachedAccessTokens.set(cacheKey, { value: body.access_token, expiresAt: Date.now() + Math.max(300, body.expires_in ?? 7200) * 1000 });
  return body.access_token;
}

/** Real marketing transport. Never uses the default/shared account or customer-service send API. */
export async function submitOfficialMassText(config:WeChatConfig,openIds:string[],content:string,clientId:string):Promise<string> {
  if(process.env.MESSAGE_CAMPAIGN_EXECUTION_ENABLED!=='true'||process.env.MESSAGE_CAMPAIGN_PROVIDER!=='wechat_mass')throw new Error('campaign_execution_disabled');
  if(!officialConfigured(config)||config.appId===process.env.SHARED_WECHAT_APP_ID)throw new Error('campaign_independent_channel_required');
  const payload=massTextPayload(openIds,content,clientId);
  const token=await accessToken(config);
  const response=await fetch(`https://api.weixin.qq.com/cgi-bin/message/mass/send?access_token=${encodeURIComponent(token)}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(10000)});
  const body=await response.json() as {errcode?:number;msg_id?:number};
  // No automatic retry: HTTP errors, malformed bodies and timeouts are uncertain outcomes.
  if(!response.ok)throw new Error('mass_send_outcome_uncertain');
  if(typeof body.errcode==='number'&&body.errcode!==0)throw new WeChatSendRejected(body.errcode);
  if(body.errcode!==0||!Number.isSafeInteger(body.msg_id)||body.msg_id!<=0)throw new Error('mass_send_outcome_uncertain');
  return String(body.msg_id);
}

export async function queryOfficialMassStatus(config:WeChatConfig,messageId:string) {
  if(!officialConfigured(config)||config.appId===process.env.SHARED_WECHAT_APP_ID||!/^\d{1,20}$/.test(messageId))throw new Error('invalid_mass_status_query');
  const token=await accessToken(config);
  const response=await fetch(`https://api.weixin.qq.com/cgi-bin/message/mass/get?access_token=${encodeURIComponent(token)}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({msg_id:messageId}),redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('mass_status_unavailable');
  return massStatus(await response.json() as Record<string,unknown>,messageId);
}

export async function sendOfficialText(userId: string, text: string, config = officialConfigFromEnv()): Promise<void> {
  if (process.env.WECHAT_LIVE_ENABLED !== "true") throw new Error("wechat_live_send_disabled");
  return sendConfiguredText(userId,text,config);
}
/** Separate manual shared-account gate; never enables the legacy or AI sender. */
export async function sendSharedOfficialText(userId:string,text:string,config:WeChatConfig):Promise<void> {
  if(process.env.SHARED_WECHAT_MANUAL_SEND_ENABLED!=='true'||config.appId!==process.env.SHARED_WECHAT_APP_ID)throw new Error('shared_send_disabled');
  return sendConfiguredText(userId,text,config);
}
async function sendConfiguredText(userId:string,text:string,config:WeChatConfig):Promise<void> {
  if (!officialConfigured(config)) throw new Error("wechat_official_not_configured");
  const send = async (token: string) => {
    const response = await fetch(`https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ touser: userId, msgtype: "text", text: { content: text.slice(0, 2000) } }),
      signal: AbortSignal.timeout(8_000)
    });
    const body = await response.json() as { errcode?: number; errmsg?: string };
    return { response, body };
  };
  let result = await send(await accessToken(config));
  if (result.body.errcode === 40014 || result.body.errcode === 42001) {
    result = await send(await accessToken(config, true));
  }
  if (!result.response.ok || result.body.errcode !== 0) {
    if (result.response.ok && Number.isInteger(result.body.errcode) && result.body.errcode! > 0) {
      throw new WeChatSendRejected(result.body.errcode!);
    }
    throw new Error("wechat_send_outcome_uncertain");
  }
}

/** Provisioning only. No callback change, message send or user association occurs here. */
export async function createSharedOfficialQr(scene: string, config: WeChatConfig, expiresIn: number | null = 600): Promise<{ ticket: string; expiresIn: number | null; imageUrl: string }> {
  if (process.env.SHARED_WECHAT_QR_ENABLED !== "true") throw new Error("shared_wechat_qr_disabled");
  sceneDigest(scene); // Only platform-generated opaque scene tokens, never tenant IDs.
  if (expiresIn !== null && (!Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > 2592000)) throw new Error("invalid_shared_qr_expiry");
  if (!officialConfigured(config)) throw new Error("wechat_official_not_configured");
  const token = await accessToken(config);
  const response = await fetch(`https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=${encodeURIComponent(token)}`, {
    method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
    body: JSON.stringify({ ...(expiresIn===null?{}:{expire_seconds:expiresIn}), action_name: expiresIn===null?"QR_LIMIT_STR_SCENE":"QR_STR_SCENE", action_info: { scene: { scene_str: scene } } }),
    signal: AbortSignal.timeout(8000)
  });
  const body = await response.json() as { ticket?: string; expire_seconds?: number; errcode?: number };
  if (!response.ok || body.errcode || typeof body.ticket !== "string" || !body.ticket || (expiresIn!==null && (!Number.isInteger(body.expire_seconds) || body.expire_seconds! <= 0 || body.expire_seconds! > expiresIn))) {
    throw new Error(`shared_wechat_qr_error:${body.errcode ?? response.status}`);
  }
  return { ticket: body.ticket, expiresIn: expiresIn===null?null:body.expire_seconds!, imageUrl: `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(body.ticket)}` };
}
